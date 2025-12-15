const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { initDB, createTask, getTasks, getTaskById, updateTaskPosition, updateTaskTags } = require('./src/database');
const { addJob } = require('./src/worker');

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
// We call it here to ensure pool is ready
initDB().catch(e => console.error("DB Init Failed:", e));

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // For API JSON body

app.get('/', async (req, res) => {
    try {
        const tasks = await getTasks();
        // Tasks are already ordered by position ASC
        res.render('index', { tasks });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get('/create', (req, res) => {
    const modules = getModules();
    res.render('create', { modules });
});

app.post('/create', upload.single('csvFile'), async (req, res) => {
    const { name, cep, csvText, moduleName } = req.body;
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
        log_file: path.join('logs', `${taskId}.txt`)
    };

    try {
        await createTask(task);
        // We DON'T call addJob here anymore! The Dispatcher in worker.js will pick it up.
        // Unless we want immediate feedback? No, Dispatcher runs every 5s.
        // It's cleaner.
        res.redirect('/');
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// API for Reordering (Drag & Drop)
app.post('/api/tasks/reorder', async (req, res) => {
    const { id, newIndex } = req.body;
    // Implementation of reordering in linked list or array logic is complex in SQL.
    // Simple approach: We receive a list of IDs in order? No, usually drag event gives start/end.
    // Better: Receive the FULL list of IDs in the new order for that column.
    
    // User interface will send: { orderedIds: ['id1', 'id2', 'id3'] }
    // We update position = array index.
    
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

// API for Tags
app.post('/api/tasks/:id/tags', async (req, res) => {
    const { tags } = req.body; // Expects JSON array of objects { name, color }
    try {
        await updateTaskTags(req.params.id, tags);
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});


app.get('/task/:id', async (req, res) => {
    try {
        const task = await getTaskById(req.params.id);
        if (!task) return res.status(404).send('Task not found');
        res.render('detail', { task });
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get('/api/logs/:id', (req, res) => {
    const logPath = path.join('logs', `${req.params.id}.txt`);
    if (fs.existsSync(logPath)) {
        res.sendFile(path.resolve(logPath));
    } else {
        res.send('');
    }
});

app.get('/download/:id', async (req, res) => {
    try {
        const task = await getTaskById(req.params.id);
        if (task && task.output_file && fs.existsSync(task.output_file)) {
            res.download(task.output_file);
        } else {
            res.status(404).send('File not found');
        }
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/task/:id/action', async (req, res) => {
    const { action } = req.body;
    const taskId = req.params.id;

    try {
        const task = await getTaskById(taskId);
        if (!task) return res.status(404).send('Task not found');

        if (action === 'abort') {
            await require('./src/database').updateTaskStatus(taskId, 'aborted');
        } else if (action === 'archive') {
             await require('./src/database').updateTaskStatus(taskId, 'archived');
        } 

        res.redirect('/');
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get('/download-template', (req, res) => {
    res.download(path.join(__dirname, 'public', 'template.csv'), 'modelo_importacao.csv');
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
