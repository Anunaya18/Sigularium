function $(id) {
    return document.getElementById(id)
}

function createEl(tag, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
}

function showMessage(msg, error = true) {
    const m = $('messages');
    m.textContent = msg || '';
    m.style.color = error ? 'var(--danger)' : 'var(--primary)';
    if (!msg) m.style.display = 'none';
    else m.style.display = 'block';
}

function parseDateSafe(d) {
    if (!d) return null;
    if (d instanceof Date) return d;
    const s = String(d);
    const parts = s.split('T')[0].split('-');
    if (parts.length >= 3) {
        const y = Number(parts[0]),
            m = Number(parts[1]),
            day = Number(parts[2]);
        if (!isNaN(y) && !isNaN(m) && !isNaN(day)) return new Date(y, m - 1, day);
    }
    return null;
}


function normalizeTask(raw, fallbackId) {
    const t = {};
    t.id = raw.id !== null ? raw.id : fallbackId;
    t.title = raw.title ? String(raw.title).trim() : `Untitled-${t.id || Math.random().toString(36).slice(2,8)}`;
    t.due_date = parseDateSafe(raw.due_date);
    t.importance = Math.min(10, Math.max(1, Number(raw.importance || 5) || 5));
    t.estimated_hours = Math.max(0, Number(raw.estimated_hours || 1) || 1);
    let deps = raw.dependencies || [];
    if (typeof deps === 'string' && deps.trim().length) {
        deps = deps.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(deps)) deps = [deps];
    t.dependencies = deps.map(d => (d === null ? d : String(d)));
    t.done = !!raw.done;
    t.blocked = !!raw.blocked;
    t.low_priority = !!raw.low_priority;
    return t;
}


function detectCycles(tasks) {
    // Build adjacency list keyed by node key (id or title)
    const keyOf = t => String(t.id !== null ? t.id : t.title);
    const graph = {};
    tasks.forEach(t => {
        graph[keyOf(t)] = (graph[keyOf(t)] || []);
    });
    tasks.forEach(t => {
        const u = keyOf(t);
        t.dependencies.forEach(d => {
            const v = String(d);
            graph[u] = graph[u] || [];
            graph[u].push(v);
            if (!(v in graph)) graph[v] = graph[v] || [];
        });
    });

    const visited = new Set(),
        stack = new Set(),
        cycles = [];

    function dfs(u, path) {
        visited.add(u);
        stack.add(u);
        const children = graph[u] || [];
        for (const v of children) {
            if (!visited.has(v)) {
                dfs(v, path.concat(v));
            } else if (stack.has(v)) {
                const idx = path.indexOf(v);
                const cyc = idx >= 0 ? path.slice(idx).concat(v) : path.concat(v);
                cycles.push(cyc);
            }
        }
        stack.delete(u);
    }
    Object.keys(graph).forEach(node => {
        if (!visited.has(node)) dfs(node, [node]);
    });
    return cycles;
}

function baseScore(task) {
    const parts = [];
    let score = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (!task.due_date) {
        score += 0;
        parts.push('no due date');
    } else {
        const due = new Date(task.due_date);
        due.setHours(0, 0, 0, 0);
        const days = Math.round((due - today) / (24 * 3600 * 1000));
        if (days < 0) {
            score += 200 + Math.abs(days) * 5;
            parts.push(`OVERDUE (${days}d)`);
        } else if (days <= 1) {
            score += 120;
            parts.push('due within 1 day');
        } else if (days <= 3) {
            score += 70;
            parts.push('due within 3 days');
        } else if (days <= 7) {
            score += 30;
            parts.push('due within 7 days');
        } else {
            score += Math.max(0, 10 - Math.floor(days / 30));
            parts.push('due later');
        }
    }
    score += task.importance * 10;
    parts.push(`importance ${task.importance}`);
    const eh = Math.max(1, Number(task.estimated_hours) || 1);
    if (eh <= 2) {
        score += 25;
        parts.push('quick win boost');
    } else if (eh <= 5) {
        score += 5;
        parts.push('medium effort');
    } else {
        score -= Math.min(15, (eh - 5));
        parts.push('large task penalty');
    }
    if (task.blocked) {
        score -= 40;
        parts.push('blocked');
    }
    if (task.low_priority) {
        score -= 20;
        parts.push('low priority');
    }
    if (task.done) {
        score -= 1000;
        parts.push('done');
    }

    return {
        score,
        parts
    };
}

function calculateScores(rawTasks, strategy = 'smart') {
    const tasks = rawTasks.map((r, i) => normalizeTask(r, r.id != null ? r.id : `auto${i+1}`));
    const key = t => String(t.id != null ? t.id : t.title);
    const map = {};
    tasks.forEach(t => map[key(t)] = t);
    const cycles = detectCycles(tasks);
    const results = tasks.map(t => {
        const base = baseScore(t);
        let s = base.score;
        const reason = [...base.parts];
        let dependents = 0;
        tasks.forEach(other => {
            if (other.dependencies.some(d => String(d) === key(t))) dependents++;
        });
        if (dependents > 0) {
            const bonus = Math.min(50, dependents * 20);
            s += bonus;
            reason.push(`blocks ${dependents} task(s) +${bonus}`);
        }
        let unresolved = 0;
        t.dependencies.forEach(dep => {
            const depTask = map[String(dep)];
            if (depTask && !depTask.done) unresolved++;
            if (!depTask) unresolved++;
        });
        if (unresolved > 0) {
            const penalty = unresolved * 30;
            s -= penalty;
            reason.push(`unresolved deps -${penalty}`);
        }
        if (strategy === 'fastest') {
            if (t.estimated_hours <= 2) {
                s += 50;
                reason.push('fastest strategy boost');
            }
        } else if (strategy === 'impact') {
            s += t.importance * 15;
            reason.push('impact strategy boost');
        } else if (strategy === 'deadline') {
            if (t.due_date) {
                const days = Math.round((new Date(t.due_date) - new Date()) / (24 * 3600 * 1000));
                if (days < 0) s += 150;
                else if (days <= 3) s += 80;
                reason.push('deadline strategy boost');
            }
        } else {}

        return {
            task: t,
            score: Math.round(s),
            reason,
            cycles
        };
    });
    results.sort((a, b) => b.score - a.score);
    return results;
}
const tasksStore = [];

function renderTaskList() {
    const container = $('taskList');
    container.innerHTML = '';
    if (tasksStore.length === 0) {
        container.classList.add('empty');
        container.textContent = 'No tasks yet. Add tasks or paste JSON above.';
        return;
    }
    container.classList.remove('empty');
    tasksStore.forEach((t, idx) => {
        const item = createEl('div', 'task-item');
        const left = createEl('div');
        left.innerHTML = `<strong>${t.title||'(untitled)'}</strong><div class="small">${t.due_date ? (new Date(t.due_date)).toLocaleDateString() : 'no due date'} • imp ${t.importance} • est ${t.estimated_hours}h</div>`;
        const right = createEl('div');
        const rm = createEl('button', 'remove-btn');
        rm.textContent = 'Remove';
        rm.addEventListener('click', () => {
            tasksStore.splice(idx, 1);
            renderTaskList();
        });
        const edit = createEl('button');
        edit.textContent = 'Edit';
        edit.style.marginRight = '8px';
        edit.addEventListener('click', () => populateFormForEdit(idx));
        right.appendChild(edit);
        right.appendChild(rm);
        item.appendChild(left);
        item.appendChild(right);
        container.appendChild(item);
    });
}

function populateFormForEdit(idx) {
    const t = tasksStore[idx];
    $('title').value = t.title || '';
    $('due_date').value = t.due_date ? new Date(t.due_date).toISOString().slice(0, 10) : '';
    $('estimated_hours').value = t.estimated_hours || '';
    $('importance').value = t.importance || '';
    $('dependencies').value = (t.dependencies && t.dependencies.join(',')) || '';
    $('done').checked = !!t.done;
    tasksStore.splice(idx, 1);
    renderTaskList();
}

function addTaskFromForm() {
    const raw = {
        title: $('title').value.trim(),
        due_date: $('due_date').value || null,
        estimated_hours: $('estimated_hours').value || 1,
        importance: $('importance').value || 5,
        dependencies: $('dependencies').value || [],
        done: $('done').checked
    };
    const t = normalizeTask(raw, `manual${Math.random().toString(36).slice(2,7)}`);
    tasksStore.push(t);
    renderTaskList();
    clearForm();
    showMessage('Task added', false);
}

function clearForm() {
    $('title').value = '';
    $('due_date').value = '';
    $('estimated_hours').value = '';
    $('importance').value = '';
    $('dependencies').value = '';
    $('done').checked = false;
}

function parseJsonInput() {
    const raw = $('jsonInput').value.trim();
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) {
            showMessage('JSON must be an array of tasks');
            return null;
        }
        arr.forEach((r, i) => {
            const t = normalizeTask(r, r.id != null ? r.id : `bulk${i+1}`);
            tasksStore.push(t);
        });
        renderTaskList();
        showMessage('Bulk tasks added', false);
        return arr;
    } catch (e) {
        showMessage('Invalid JSON: ' + e.message);
        return null;
    }
}

function downloadJSON() {
    const a = document.createElement('a');
    const blob = new Blob([JSON.stringify(tasksStore, null, 2)], {
        type: 'application/json'
    });
    a.href = URL.createObjectURL(blob);
    a.download = 'tasks.json';
    a.click();
}

function renderResults(results, topOnly = false) {
    const container = $('results');
    container.innerHTML = '';
    const meta = $('resultMeta');
    meta.textContent = `Strategy: ${$('strategy').value} | ${results.length} tasks | ${results.filter(r=>r.cycles && r.cycles.length).length ? 'Cycle(s) detected' : 'No cycles'}`;
    if (results.length === 0) {
        container.innerHTML = '<div class="empty">No tasks to analyze</div>';
        return;
    }
    const display = topOnly ? results.slice(0, 3) : results;
    const anyCycles = results.some(r => r.cycles && r.cycles.length);
    if (anyCycles) {
        const warn = createEl('div', 'explanation');
        warn.innerHTML = `<strong>⚠ Circular dependency detected</strong><br/> Some tasks have circular dependencies. These are highlighted in results. Resolve cycles to get consistent priorities.`;
        container.appendChild(warn);
    }

    display.forEach(item => {
        const card = createEl('div', 'card');
        const cls = (item.score >= 150 ? 'high' : (item.score >= 60 ? 'med' : 'low'));
        card.classList.add(cls);
        const t = item.task;
        card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
      <div><strong>${t.title}</strong><div class="small">${t.id ? `id: ${t.id}`: ''} ${t.due_date ? ' • due ' + new Date(t.due_date).toLocaleDateString() : ''}</div></div>
      <div style="text-align:right"><span class="badge">Score: ${item.score}</span></div>
    </div>
    <div class="meta">Importance: ${t.importance} • Est hrs: ${t.estimated_hours} • Dependencies: ${t.dependencies.length || 0} ${t.done ? ' • DONE' : ''}</div>
    <div class="explanation"><strong>Why:</strong> ${item.reason.join(', ') || 'Calculated'}</div>
    <pre style="margin-top:8px;background:#fbfdff;padding:8px;border-radius:6px;font-size:12px">${JSON.stringify(t, null, 2)}</pre>
    `;
        container.appendChild(card);
    });
}
document.addEventListener('DOMContentLoaded', () => {
    // wire buttons
    $('addTaskBtn').addEventListener('click', addTaskFromForm);
    $('clearFormBtn').addEventListener('click', clearForm);
    $('analyzeBtn').addEventListener('click', () => {
        showMessage('');
        if ($('jsonInput').value.trim()) {
            const parsed = parseJsonInput();
            if (parsed === null) return;
        }
        const strategy = $('strategy').value;
        const results = calculateScores(tasksStore, strategy);
        renderResults(results, false);
    });

    $('suggestBtn').addEventListener('click', () => {
        showMessage('');
        if ($('jsonInput').value.trim()) {
            const parsed = parseJsonInput();
            if (parsed === null) return;
        }
        const strategy = $('strategy').value;
        const results = calculateScores(tasksStore, strategy);
        renderResults(results, true);
    });

    $('downloadBtn').addEventListener('click', downloadJSON);

    tasksStore.push(normalizeTask({
        id: 1,
        title: 'Fix login bug',
        due_date: new Date().toISOString().slice(0, 10),
        estimated_hours: 3,
        importance: 8,
        dependencies: []
    }, 1));
    tasksStore.push(normalizeTask({
        id: 2,
        title: 'Write README',
        due_date: null,
        estimated_hours: 1,
        importance: 6,
        dependencies: []
    }, 2));
    tasksStore.push(normalizeTask({
        id: 3,
        title: 'Payment API',
        due_date: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10),
        estimated_hours: 6,
        importance: 9,
        dependencies: [1]
    }, 3));
    renderTaskList();
});
