/**
 * UI管理器 - 现代化图层切换
 */

const UIManager = (function() {
    let isDark = false;
    let isFullscreen = false;
    let sortableInstances = [];
    let searchKeyword = '';
    let stylePanelLayerId = null;
    // R108：标注设置弹窗模式：null=全局默认值，id=指定图层的 per-layer 覆盖
    let labelPanelLayerId = null;
    // R110：预览模式下「待应用」工作副本——输入只更新预览，点击「完成」才写入地图
    let pendingStyle = null;
    let pendingLabel = null;

    // 已折叠的数据集分组（localStorage 持久化）
    const COLLAPSE_STORAGE_KEY = 'lyc_collapsed_groups_v1';
    const collapsedGroups = new Set(readCollapsedGroups());
    let lastAddedGroup = null; // R143：「最新添加」的数据集（折叠逻辑只保留它展开）

    // 数据集视图中已折叠的「分类分组」（localStorage 持久化，与图层分组折叠互相独立）
    const CAT_COLLAPSE_STORAGE_KEY = 'lyc_ds_cat_collapsed_v1';
    const collapsedCategories = new Set(readCollapsedCategories());

    function readCollapsedGroups() {
        try {
            const value = JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY));
            return Array.isArray(value) ? value : [];
        } catch (error) { return []; }
    }

    function persistCollapsedGroups() {
        try {
            localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...collapsedGroups]));
        } catch (error) { /* 存储失败不阻塞交互 */ }
    }

    function readCollapsedCategories() {
        try {
            const value = JSON.parse(localStorage.getItem(CAT_COLLAPSE_STORAGE_KEY));
            return Array.isArray(value) ? value : [];
        } catch (error) { return []; }
    }

    function persistCollapsedCategories() {
        try {
            localStorage.setItem(CAT_COLLAPSE_STORAGE_KEY, JSON.stringify([...collapsedCategories]));
        } catch (error) { /* 存储失败不阻塞交互 */ }
    }

    // 数据集介绍摘要：列表里只显示「一句话」，且必须单行显示，完整介绍交给悬停提示。
    // 单行容量：380px 面板下可用约 217px，12px 字体 ≈ 18 个中文字，故上限取 17 留安全余量。
    const INFO_SUMMARY_MAX = 17;

    // 超过单行容量时逐级压缩：去括号补充 → 顿号列举缩为「首项+等」→ 只用首分句 → 硬截断
    function compressInfo(summary, clauses, maxLen) {
        const steps = [];
        // 1) 去掉括号及其中的补充说明：（隋称显仁宫苑）/ (二里头遗址) 等
        const noParen = summary.replace(/[（(][^（()）]*[）)]/g, '').replace(/\s{2,}/g, ' ').trim();
        if (noParen && noParen.length !== summary.length) steps.push(noParen);
        // 2) 顿号列举（3 项以上）缩为「首项+等」：东汉、曹魏、西晋、北魏等 → 东汉等
        const source = steps[0] || summary;
        const condensed = source.replace(/([^、，,；;]{1,10})(?:、[^、，,；;]{1,10}){2,}(?=等)/g, '$1');
        if (condensed !== source) steps.push(condensed);
        // 3) 退回只用第一个分句
        if (clauses[0] && clauses[0] !== summary) steps.push(clauses[0]);
        // 按压缩强度依次取第一个能放进单行的结果（越靠前保留的信息越多）
        for (const candidate of steps) {
            if (candidate && candidate.length <= maxLen) return candidate;
        }
        // 都不够短：取最短候选再硬截断（正常情况下走不到）
        const shortest = steps.concat(summary).sort((a, b) => a.length - b.length)[0] || summary;
        return shortest.length > maxLen ? shortest.slice(0, maxLen) + '…' : shortest;
    }

    function summarizeInfo(info) {
        const text = String(info || '').trim();
        if (!text) return '';
        const firstSentence = text.split(/[。！？!?]/)[0].trim();
        if (!firstSentence) return text;
        if (firstSentence.length <= 14) return firstSentence + '。';
        const clauses = firstSentence.split(/[，,；;]/).map(part => part.trim()).filter(Boolean);
        let summary = clauses[0] || firstSentence;
        // 首分句太短（<12 字）并上第二分句，避免出现「洛阳盆地古代水系」这种残句
        if (summary.length < 12 && clauses.length > 1) summary = clauses.slice(0, 2).join('，');
        if (summary.length > INFO_SUMMARY_MAX) summary = compressInfo(summary, clauses, INFO_SUMMARY_MAX);
        return summary;
    }

    // 分类图标：按类别给一个直观图形（缺省用文件夹）
    function categoryIcon(category) {
        if (/洛阳|北京/.test(category)) return 'fa-landmark';
        if (/行政区划/.test(category)) return 'fa-map';
        if (/水系|要素/.test(category)) return 'fa-water';
        return 'fa-folder';
    }

    const BUTTON_IDS = [
        'datasetVisToggle',
        'zoomToAll',
        'footerRemoveAll'
    ];

    function init() {
        bindEvents();
        initSortable();
        initTooltips();
        document.addEventListener('fullscreenchange', syncFullscreenState);

        let savedTheme = null;
        try { savedTheme = localStorage.getItem('mapTheme'); } catch (error) { /* 存储不可用（隐私模式/被禁用）时按默认亮色 */ }
        // R94：恢复主题改为静默赋值（不再借道 toggleTheme——旧写法会在每次打开页面时
        // 弹出「切换到暗色主题」toast，且多一次无意义的底图切换调用）
        if (savedTheme === 'dark') {
            isDark = true;
            document.documentElement.setAttribute('data-theme', 'dark');
            const icon = document.querySelector('#toggleTheme i');
            if (icon) icon.className = 'fas fa-sun';
        } else {
            isDark = false;
            document.documentElement.setAttribute('data-theme', 'light');
        }
        // R90：主题与底图联动——暗色主题载入时即切换到暗黑底图
        applyBasemapForTheme();
        // R95：非原生暗色底图（OSM/影像等）在暗色主题下套瓦片暗色滤镜
        if (MapManager.refreshTilesThemeFilter) MapManager.refreshTilesThemeFilter();

        // R90：注册数据集加载监听，加载未完成时显示「加载中」遮罩
        if (LayerManager.setLoadingListener) {
            LayerManager.setLoadingListener(onDatasetLoadingChange);
        }

        // R86：恢复上次面板宽度（仅桌面端；移动端为抽屉，宽度由媒体查询控制）
        if (!isMobile()) {
            try {
                const savedW = parseInt(localStorage.getItem('lyc_sidebar_width'), 10);
                if (savedW >= 220 && savedW <= 560) {
                    document.documentElement.style.setProperty('--sidebar-width', savedW + 'px');
                }
            } catch (error) { /* 存储不可用时使用默认宽度 */ }
        }

        updateButtonsState(false);
        applyPanelButtonState();
        initLabelSettings();
    }

    // R90：数据集加载状态 →「加载中」遮罩（支持并发加载计数）
    let loadingCount = 0;
    function onDatasetLoadingChange(state, name) {
        loadingCount += state ? 1 : -1;
        if (loadingCount < 0) loadingCount = 0;
        const el = document.getElementById('globalLoading');
        if (!el) return;
        if (loadingCount > 0) {
            const txt = el.querySelector('.loading-text');
            if (txt) txt.textContent = name ? `正在加载：${name}…` : '正在加载数据集…';
            el.hidden = false;
        } else {
            el.hidden = true;
        }
    }

    // R90：主题与底图联动——暗色→暗黑底图，亮色→冷色底图
    function applyBasemapForTheme() {
        try {
            const current = MapManager.getCurrentBaseLayer();
            // 仅当当前底图为冷色 / 暗黑地图时才随主题联动；使用其他底图（地形 / 影像 / OSM 等）时保持不变
            if (current !== 'Esri冷色地图' && current !== 'Esri暗黑地图') return;
            const target = isDark ? 'Esri暗黑地图' : 'Esri冷色地图';
            if (current !== target && CONFIG.baseLayers[target]) {
                MapManager.switchBaseLayer(target);
            }
        } catch (e) { /* 地图未就绪时忽略 */ }
    }

    // ---------- 工具 ----------
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[character]));
    }

    function getCurrentLayers() {
        return LayerManager.getAllLayers();
    }

    function getGeometrySummary(data) {
        const type = getLayerGeometryType(data);
        if (type === 'point') return { label: '点', icon: 'fa-location-dot', type };
        if (type === 'line') return { label: '线', icon: 'fa-route', type };
        if (type === 'polygon') return { label: '面', icon: 'fa-draw-polygon', type };
        return { label: '要素', icon: 'fa-shapes', type: 'mixed' };
    }

    // 图层几何大类：point | line | polygon | mixed
    function getLayerGeometryType(data) {
        const types = new Set((data.features || []).map(feature => feature.geometry?.type).filter(Boolean));
        if (types.size === 0) return 'mixed';
        const kinds = new Set();
        types.forEach(t => {
            if (t === 'Point' || t === 'MultiPoint') kinds.add('point');
            else if (t === 'LineString' || t === 'MultiLineString') kinds.add('line');
            else if (t === 'Polygon' || t === 'MultiPolygon') kinds.add('polygon');
            else kinds.add('mixed');
        });
        if (kinds.size === 1) return [...kinds][0];
        return 'mixed';
    }


    // ================================================================
    // 图层面板视图（R127）：顶部 Tab 在「数据集 / 图层」两视图间切换
    // 数据集视图：列出全部数据集（名称 + info 说明 + 图层构成 点/线/面），
    //   每行一个「添加 / 已添加」切换；已加载行用主题蓝强调（左侧蓝条 + 蓝色实心 pill）。
    // 图层视图：沿用既有分组图层列表（显隐眼睛等），逻辑不变。
    // 添加 / 移除 / 添加全部 / 移除全部 逻辑与早期下拉菜单一致（默认加载行为不变）。
    // ================================================================
    let activePanelView = 'datasets';

    // 渲染数据集视图（#datasetList）
    function renderDatasetView() {
        const list = document.getElementById('datasetList');
        if (!list) return;
        const datasets = DataScanner.getDatasets();
        const loadedGroups = new Set(LayerManager.getLoadedGroupNames());

        if (datasets.length === 0) {
            list.innerHTML = '<div class="dataset-empty"><i class="fas fa-database"></i>暂无可用数据集</div>';
            return;
        }

        // 单行数据集渲染（分类分组内复用）
        const renderRow = dataset => {
            const loaded = loadedGroups.has(dataset.name);
            const safeName = escapeHtml(dataset.name);
            const fullInfo = dataset.info || '';
            // 列表只显示一句话摘要；完整介绍放到悬停提示（data-tooltip-wrap → 宽版换行气泡）
            const info = fullInfo ? escapeHtml(summarizeInfo(fullInfo)) : '暂无说明';
            const tooltipAttr = fullInfo
                ? ` data-tooltip="${escapeHtml(fullInfo)}" data-tooltip-wrap`
                : '';
            const layerCount = dataset.sources.length;
            // 从 manifest style 推断各图层几何类型（未加载也能显示构成）
            const counts = { point: 0, line: 0, polygon: 0 };
            dataset.sources.forEach(src => {
                const s = src.style || {};
                if ('pointColor' in s) counts.point += 1;
                else if ('lineColor' in s) counts.line += 1;
                else if ('fillColor' in s) counts.polygon += 1;
            });
            let composition = `${layerCount} 图层`;
            const parts = [];
            if (counts.point) parts.push(`点 ${counts.point}`);
            if (counts.line) parts.push(`线 ${counts.line}`);
            if (counts.polygon) parts.push(`面 ${counts.polygon}`);
            if (parts.length) composition += ` · ${parts.join(' · ')}`;
            return `
                <div class="dataset-row${loaded ? ' is-loaded' : ''}" data-name="${safeName}" data-info="${escapeHtml(fullInfo)}"${tooltipAttr}>
                    <span class="dataset-row-icon"><i class="fas fa-database"></i></span>
                    <div class="dataset-row-main">
                        <div class="dataset-row-name">${safeName}</div>
                        <div class="dataset-row-info">${info}</div>
                        <div class="dataset-row-meta">${composition}</div>
                    </div>
                    <button type="button" class="ds-pill${loaded ? ' is-loaded' : ''}" data-action="${loaded ? 'remove' : 'add'}" data-tooltip="${loaded ? '从图层中移除' : '添加到图层'}" aria-label="${loaded ? '移除' : '添加'}${safeName}">
                        ${loaded
                            ? '<i class="fas fa-check"></i> 已添加'
                            : '<i class="fas fa-plus"></i> 添加'}
                    </button>
                </div>`;
        };

        // 按分类分组渲染（顺序来自 DataScanner.getCategories()）
        const categories = DataScanner.getCategories();
        list.innerHTML = categories.map(category => {
            const safeCat = escapeHtml(category);
            const items = DataScanner.getDatasetsByCategory(category);
            const loadedCount = items.filter(d => loadedGroups.has(d.name)).length;
            const allLoaded = loadedCount === items.length;
            const collapsed = collapsedCategories.has(category);
            return `
                <div class="dataset-cat${collapsed ? ' collapsed' : ''}" data-category="${safeCat}">
                    <div class="dataset-cat-header" data-tooltip="${collapsed ? '展开分组' : '折叠分组'}">
                        <button type="button" class="dataset-cat-collapse" aria-label="${collapsed ? '展开' : '折叠'}${safeCat}">
                            <i class="fas fa-chevron-down"></i>
                        </button>
                        <span class="dataset-cat-icon"><i class="fas ${categoryIcon(category)}"></i></span>
                        <span class="dataset-cat-name">${safeCat}</span>
                        <span class="dataset-cat-count">${loadedCount}/${items.length}</span>
                        <button type="button" class="dataset-cat-pill${allLoaded ? ' is-loaded' : ''}" data-action="${allLoaded ? 'remove' : 'add'}" data-tooltip="${allLoaded ? '从图层中移除' : '添加到图层'}" aria-label="${allLoaded ? '移除' : '添加'}${safeCat}全部数据集">
                            ${allLoaded
                                ? '<i class="fas fa-check"></i> 已添加'
                                : '<i class="fas fa-plus"></i> 添加'}
                        </button>
                    </div>
                    <div class="dataset-cat-items">
                        ${items.map(renderRow).join('')}
                    </div>
                </div>`;
        }).join('');

        // 绑定每行添加 / 移除
        list.querySelectorAll('.dataset-row').forEach(row => {
            const btn = row.querySelector('.ds-pill');
            if (!btn) return;
            btn.addEventListener('click', async () => {
                const name = row.dataset.name;
                if (btn.dataset.action === 'add') {
                    await addDatasets([name]);
                    renderDatasetView();
                    if (activePanelView === 'layers') updateLayerPanel();
                } else {
                    LayerManager.removeDataset(name);
                    showToast(`已移除「${name}」`, 'info');
                    renderDatasetView();
                    if (activePanelView === 'layers') updateLayerPanel();
                }
            });
        });

        // 分组头：折叠/展开（点标题区任意处）+ 整组添加/移除
        list.querySelectorAll('.dataset-cat').forEach(groupEl => {
            const category = groupEl.dataset.category;
            const header = groupEl.querySelector('.dataset-cat-header');
            const collapseBtn = groupEl.querySelector('.dataset-cat-collapse');
            const pill = groupEl.querySelector('.dataset-cat-pill');

            const toggleCollapse = () => {
                const nowCollapsed = !groupEl.classList.contains('collapsed');
                groupEl.classList.toggle('collapsed', nowCollapsed);
                if (nowCollapsed) collapsedCategories.add(category);
                else collapsedCategories.delete(category);
                collapseBtn.setAttribute('aria-label', `${nowCollapsed ? '展开' : '折叠'}${category}`);
                header.setAttribute('data-tooltip', nowCollapsed ? '展开分组' : '折叠分组');
                persistCollapsedCategories();
            };

            header.addEventListener('click', event => {
                // 整组按钮独立处理，不触发折叠
                if (event.target.closest('.dataset-cat-pill')) return;
                toggleCollapse();
            });

            pill.addEventListener('click', async () => {
                const names = DataScanner.getDatasetsByCategory(category).map(d => d.name);
                if (pill.dataset.action === 'add') {
                    await addDatasets(names);
                } else {
                    const loaded = new Set(LayerManager.getLoadedGroupNames());
                    names.forEach(name => { if (loaded.has(name)) LayerManager.removeDataset(name); });
                    showToast(`已移除「${category}」全部数据集`, 'info');
                }
                renderDatasetView();
                if (activePanelView === 'layers') updateLayerPanel();
            });
        });

        // 数据集视图统计随添加 / 移除实时刷新
        updatePanelStats();
        // R141：添加/移除后保留当前搜索过滤——重新渲染列表后立刻按既有 searchKeyword 重新套用过滤（输入框文本不丢失）
        applyPanelSearch();
    }

    // 视图感知统计条：数据集视图显示「数据集总量 / 已加载」，图层视图显示「已加载数据集 / 图层总量 / 可见」
    function updatePanelStats() {
        const el = document.getElementById('panelStats');
        if (!el) return;
        if (activePanelView === 'datasets') {
            const total = DataScanner.getDatasets().length;
            const loaded = LayerManager.getLoadedGroupNames().length;
            el.innerHTML =
                `<span class="stat"><span class="stat-num">${total}</span><span class="stat-label">数据集</span></span>` +
                `<span class="stat-sep">·</span>` +
                `<span class="stat"><span class="stat-num">${loaded}</span><span class="stat-label">已加载</span></span>`;
        } else {
            const all = getCurrentLayers();
            const loadedDatasets = new Set([...all.values()].map(i => i.config.group)).size;
            const totalLayers = all.size;
            const visible = [...all.values()].filter(info => info.visible && !LayerManager.isDatasetHidden(info.config.group)).length;
            el.innerHTML =
                `<span class="stat"><span class="stat-num">${loadedDatasets}</span><span class="stat-label">数据集</span></span>` +
                `<span class="stat-sep">·</span>` +
                `<span class="stat"><span class="stat-num">${totalLayers}</span><span class="stat-label">图层</span></span>` +
                `<span class="stat-sep">·</span>` +
                `<span class="stat"><span class="stat-num">${visible}</span><span class="stat-label">可见</span></span>`;
        }
    }

    // 切换面板视图（datasets / layers）
    function setActivePanelView(view) {
        activePanelView = view;
        const tabs = document.querySelectorAll('.panel-tab');
        tabs.forEach(tab => {
            const on = tab.dataset.view === view;
            tab.classList.toggle('is-active', on);
            tab.setAttribute('aria-selected', String(on));
        });
        const datasetView = document.getElementById('datasetView');
        const layerView = document.getElementById('layerView');
        if (datasetView) datasetView.hidden = (view !== 'datasets');
        if (layerView) layerView.hidden = (view !== 'layers');
        const groupActions = document.getElementById('groupToggleActions');
        if (groupActions) groupActions.hidden = (view !== 'layers');

        // 工具栏右侧批量按钮：仅数据集视图显示「添加全部 / 移除全部」
        const bulkActions = document.getElementById('datasetBulkActions');
        if (bulkActions) bulkActions.hidden = (view !== 'datasets');

        // 底部「隐藏/显示所有数据集 + 缩放至全部可见图层」在两个视图均显示（数据集/图层标签都适用）
        // R141：底部「移除全部数据集」仅图层视图显示（数据集视图已有工具栏「移除全部」）
        const footerRemoveAll = document.getElementById('footerRemoveAll');
        if (footerRemoveAll) footerRemoveAll.hidden = (view !== 'layers');

        const searchInput = document.getElementById('layerSearch');
        if (searchInput) {
            searchInput.placeholder = view === 'datasets' ? '搜索数据集...' : '搜索图层...';
        }
        if (view === 'datasets') renderDatasetView();
        applyPanelSearch();
        // 切到图层视图时同步底部按钮（隐藏/缩放）的可用态与图标
        updateButtonsState();
        // 视图切换后刷新统计条（数据集 / 图层 各自统计）
        updatePanelStats();
    }

    // 批量：添加全部 / 移除全部
    async function datasetAddAll() {
        const all = DataScanner.getDatasets().map(d => d.name);
        const loaded = new Set(LayerManager.getLoadedGroupNames());
        const toAdd = all.filter(n => !loaded.has(n));
        if (toAdd.length === 0) { showToast('所有数据集已添加', 'info'); return; }
        await addDatasets(toAdd);
        renderDatasetView();
        if (activePanelView === 'layers') updateLayerPanel();
    }

    async function datasetRemoveAll() {
        const loaded = LayerManager.getLoadedGroupNames();
        if (loaded.length === 0) { showToast('当前没有已添加的数据集', 'info'); return; }
        const ok = await showAppModal({
            icon: 'fa-trash-can',
            title: '移除全部数据集',
            message: `将从地图移除全部 ${loaded.length} 个已添加数据集，其图层将从地图与列表中移除，可随时重新添加。`,
            confirmText: '移除全部',
            danger: true,
        });
        if (!ok) return;
        loaded.forEach(name => LayerManager.removeDataset(name));
        showToast(`已移除 ${loaded.length} 个数据集`, 'info');
        renderDatasetView();
        if (activePanelView === 'layers') updateLayerPanel();
    }

    // 批量加载数据集：并行加载、汇总成功/失败、统一重排一次；全部加载后缩放到整体范围
    // R143：新加载数据集默认展开；分组 > 6 时仅展开「最新添加」的数据集，其余折叠
    function autoCollapseGroupsIfMany() {
        const groups = LayerManager.getLoadedGroupNames();
        collapsedGroups.clear();
        if (groups.length > 6) {
            // 仅保留「最新添加」的数据集展开，其余折叠
            const keep = groups.includes(lastAddedGroup) ? lastAddedGroup : groups[groups.length - 1];
            groups.forEach(name => { if (name !== keep) collapsedGroups.add(name); });
        }
        // ≤6：全部展开（collapsedGroups 已清空）；>6：除最新添加外均折叠
        persistCollapsedGroups();
        applyCollapseToDom();
    }

    // 按 collapsedGroups 把折叠状态同步到 DOM（折叠类 + aria + 分组按钮态）
    function applyCollapseToDom() {
        document.querySelectorAll('#layerList .layer-group').forEach(groupEl => {
            const collapsed = collapsedGroups.has(groupEl.dataset.group);
            groupEl.classList.toggle('collapsed', collapsed);
            const collapseBtn = groupEl.querySelector('.layer-group-collapse');
            if (collapseBtn) collapseBtn.setAttribute('aria-expanded', String(!collapsed));
        });
        updateGroupButtonsState();
    }

    async function addDatasets(names) {
        if (!names || names.length === 0) return;
        const bounds = L.latLngBounds();
        let hasValid = false;
        let loaded = 0;
        const failedNames = [];
        // 批量添加：统一显示一次加载遮罩（避免逐个数据集闪烁），并行加载全部数据集
        const label = names.length > 1 ? `正在添加 ${names.length} 个数据集` : (names[0] || '');
        LayerManager.setLoading(true, label);
        try {
            // 并行加载（defer：暂不重排/刷新 UI），最后统一重排一次，顺序语义与逐个添加完全一致
            const results = await Promise.all(names.map(name => LayerManager.loadDataset(name, { defer: true })));
            const newIds = [];
            results.forEach((result, i) => {
                const name = names[i];
                if (result.ids) newIds.push(...result.ids);
                if (result.loaded > 0) {
                    loaded += 1;
                    LayerManager.getLayersByGroup(name).forEach(info => {
                        if (info.visible && info.layer.getBounds && info.layer.getBounds().isValid()) {
                            bounds.extend(info.layer.getBounds());
                            hasValid = true;
                        }
                    });
                }
                if (result.failed > 0) failedNames.push(name);
            });
            // 新添加的数据集默认置于顶部：批量加载完成后统一置顶一次（内部按清单顺序稳定排列）
            if (newIds.length) LayerManager.prependNewLayersOnTop(newIds);
            // 统一重排图层顺序 + 地图叠加次序 + 刷新 UI（仅一次，替代每个数据集重复全量重排）
            LayerManager.finalizeBatchLoad();
            if (hasValid) MapManager.fitBounds(bounds);
            // 记录「最新添加」的数据集，供折叠逻辑只保留它展开（需在 finalize 之后）
            lastAddedGroup = names[names.length - 1];
            if (loaded > 0) {
                showToast(`已加载 ${loaded} 个数据集`, 'success');
                // R143：分组 > 6 仅展开最新添加的数据集；≤ 6 全部展开
                autoCollapseGroupsIfMany();
            }
            if (failedNames.length > 0) showToast(`${failedNames.join('、')} 部分图层加载失败`, 'warning');
        } finally {
            LayerManager.setLoading(false, label);
        }
    }

    function initTooltips() {
        let tooltip = null;
        let activeElement = null;
        // R88：记录当前正在显示提示的 [data-tooltip] 元素，避免在同一元素与其子节点间移动时反复销毁重建（悬停闪烁的根因）
        let activeTooltipEl = null;

        const hideTooltip = function() {
            if (tooltip) tooltip.remove();
            tooltip = null;
            activeElement = null;
            activeTooltipEl = null;
        };

        const showTooltip = function(element) {
            const text = element.dataset.tooltip;
            if (!text) return;
            // 同一元素已在显示则不再重建，杜绝闪烁
            if (activeTooltipEl === element) return;
            hideTooltip();
            activeElement = element;
            activeTooltipEl = element;
            tooltip = document.createElement('div');
            // data-tooltip-wrap：长文本（如数据集完整介绍）用宽版换行气泡
            tooltip.className = 'app-tooltip' + (element.hasAttribute('data-tooltip-wrap') ? ' app-tooltip--wrap' : '');
            tooltip.textContent = text;
            document.body.appendChild(tooltip);

            const rect = element.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            const gap = 8;
            let left = rect.left + (rect.width - tooltipRect.width) / 2;
            let top = rect.top - tooltipRect.height - gap;

            if (top < 8) top = rect.bottom + gap;
            // 上方放不下改放下方后，若下方也超出视口则贴住视口内（长文本气泡不会被截断）
            if (top + tooltipRect.height > window.innerHeight - 8) {
                top = Math.max(8, window.innerHeight - tooltipRect.height - 8);
            }
            left = Math.max(8, Math.min(left, window.innerWidth - tooltipRect.width - 8));
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        };

        document.addEventListener('pointerover', event => {
            const element = event.target.closest?.('[data-tooltip]');
            if (element) showTooltip(element);
        });
        document.addEventListener('pointerout', event => {
            if (!activeTooltipEl) return;
            // 仅当指针离开当前提示元素、且未进入同一提示元素（含其子节点）时才隐藏
            const to = (event.relatedTarget && event.relatedTarget.closest)
                ? event.relatedTarget.closest('[data-tooltip]') : null;
            if (to !== activeTooltipEl) hideTooltip();
        });
        document.addEventListener('focusin', event => {
            const element = event.target.closest?.('[data-tooltip]');
            if (element) showTooltip(element);
        });
        document.addEventListener('focusout', hideTooltip);
        window.addEventListener('resize', hideTooltip);
        window.addEventListener('scroll', hideTooltip, true);
    }

    function initSortable() {
        const container = document.getElementById('layerList');
        if (!container) return;
        // 防御：Sortable 未加载（本地 vendor 文件缺失等）时不中断其余初始化
        if (typeof Sortable === 'undefined') {
            console.warn('[UIManager] SortableJS 未加载，图层拖拽排序不可用');
            return;
        }

        sortableInstances.forEach(instance => instance.destroy());
        sortableInstances = [];

        // 每个数据集分组一个 Sortable 实例：图层只能在本分组内拖拽排序，
        // 整体顺序 = 各分组在 DOM 中的先后 + 组内顺序
        // R86：取消 handle 限制，整行任意位置「长按」即可拖曳（不再仅限六点把手）；
        // delay + delayOnTouchOnly 让触摸端需长按、桌面端直接拖；filter 排除交互按钮（点击仍生效）。
        container.querySelectorAll('.layer-group-items').forEach(groupContainer => {
            sortableInstances.push(Sortable.create(groupContainer, {
                animation: 250,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                ghostClass: 'sortable-ghost',
                chosenClass: 'sortable-chosen',
                dragClass: 'sortable-drag',
                forceFallback: true,
                fallbackOnBody: true,
                fallbackTolerance: 2,
                delay: 200,
                delayOnTouchOnly: true,
                touchStartThreshold: 5,
                filter: '.vis-btn, .layer-swatch, .zoom-btn, .label-btn, .layer-actions',
                preventOnFilter: false,
                // 拖拽期间容器加 sorting-active：图层行 transition 全部归零，
                // 避免 .layer-item 的 transition: all 与 Sortable 让位动画叠加造成卡顿（流畅度核心）
                onStart: () => container.classList.add('sorting-active'),
                onEnd: function() {
                    container.classList.remove('sorting-active');
                    LayerManager.setLayerOrder(collectLayerOrder(container));
                }
            }));
        });

        // 分组级 Sortable：整个数据集分组可拖拽调整加载顺序。
        // R86：handle 放宽到分组头整体（长按分组头任意处即可拖，不再仅限六点把手）；
        // filter 排除头部按钮，短按头部仍折叠/展开分组。分组顺序 = 图层顺序的子集（同一分组图层连续）
        // ——拖完后按新 DOM 顺序重排图层即可，setLayerOrder 会同时重设 z-order 并持久化到 lyc_layer_order_v1。
        sortableInstances.push(Sortable.create(container, {
            handle: '.layer-group-header',
            animation: 250,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            ghostClass: 'sortable-ghost',
            chosenClass: 'sortable-chosen',
            dragClass: 'sortable-drag',
            forceFallback: true,
            fallbackOnBody: true,
            fallbackTolerance: 2,
            delay: 200,
            delayOnTouchOnly: true,
            touchStartThreshold: 5,
            filter: '.layer-group-collapse, .layer-group-more, .layer-group-vis, button',
            preventOnFilter: false,
            onStart: () => container.classList.add('sorting-active'),
            onEnd: function() {
                container.classList.remove('sorting-active');
                LayerManager.setLayerOrder(collectLayerOrder(container));
            }
        }));
    }

    // 按当前 DOM 顺序收集全部图层 id（分组拖拽后分组顺序变化，图层顺序随之变化）
    function collectLayerOrder(container) {
        const orderedIds = [];
        container.querySelectorAll('.layer-item').forEach(item => {
            const id = item.dataset.id;
            if (id) orderedIds.push(id);
        });
        return orderedIds;
    }

    function updateButtonsState(enabled = LayerManager.getAllLayers().size > 0) {
        BUTTON_IDS.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = !enabled;
        });

        // 样式面板内「恢复默认」按钮：样式偏离默认值时才可点击（面板打开时同步）
        const styleResetBtn = document.getElementById('styleReset');
        if (styleResetBtn && stylePanelLayerId) {
            styleResetBtn.disabled = LayerManager.isLayerStyleDefault(stylePanelLayerId);
        }

        const layerList = document.getElementById('layerList');
        if (layerList) {
            layerList.style.opacity = enabled ? '1' : '0.6';
        }
        const zoomToAll = document.getElementById('zoomToAll');
        if (zoomToAll) {
            // R89：缩放至全部可见图层需关联数据集显隐——被隐藏数据集的图层即使个体可见也不计入
            const currentLayers = [...getCurrentLayers().values()];
            const hasVisibleLayer = currentLayers.some(info => info.visible && !LayerManager.isDatasetHidden(info.config.group));
            zoomToAll.disabled = !enabled || !hasVisibleLayer;
        }
        // R89：底部「显示/隐藏所有数据集」切换键随数据集显隐同步图标与可用态
        updateDatasetToggleButton();

        // 展开/折叠所有分组按钮：可用态只取决于分组折叠情况，统一交给 updateGroupButtonsState；
        // 分组头 显示/隐藏/缩放 按钮可用态随图层可见性变化同步
        updateGroupButtonsState();
        syncGroupVisButtons();
        // 图层显隐 / 数据集显隐 变化后，统计条的「可见」数量需同步刷新
        updatePanelStats();
    }

    // 同步所有分组头 显示/隐藏/缩放 按钮可用态（批量显隐/单图层切换后由 updateButtonsState 调用）
    function syncGroupVisButtons() {
        document.querySelectorAll('#layerList .layer-group').forEach(groupEl => {
            updateGroupVisButtons(groupEl, groupEl.dataset.group);
        });
    }

    // R89：底部「显示/隐藏所有数据集」切换键——依当前是否仍有被隐藏的数据集决定本次动作与图标
    function updateDatasetToggleButton() {
        const btn = document.getElementById('datasetVisToggle');
        if (!btn) return;
        const allLayers = getCurrentLayers();
        const hasDatasets = allLayers.size > 0;
        const anyHidden = hasDatasets && [...new Set([...allLayers.values()].map(i => i.config.group))].some(g => LayerManager.isDatasetHidden(g));
        const icon = btn.querySelector('i');
        if (anyHidden) {
            // 仍有被隐藏的数据集 → 本次点击 = 显示所有（眼睛图标）
            if (icon) icon.className = 'fas fa-eye';
            btn.dataset.tooltip = '显示所有数据集';
            btn.setAttribute('aria-label', '显示所有数据集');
        } else {
            // 全部已显示 → 本次点击 = 隐藏所有（眼睛斜杠图标）
            if (icon) icon.className = 'fas fa-eye-slash';
            btn.dataset.tooltip = '隐藏所有数据集';
            btn.setAttribute('aria-label', '隐藏所有数据集');
        }
        btn.disabled = !hasDatasets;
    }

    function bindEvents() {
        // 点击任何位置关闭分组头「更多」菜单（菜单项与更多按钮均已 stopPropagation）
        document.addEventListener('click', closeAllGroupMoreMenus);
        // R108：点击任何位置关闭图层行「更多」菜单
        document.addEventListener('click', closeAllLayerMoreMenus);
        // 任何容器滚动时让「更多」菜单跟随按钮重新定位（scroll 不冒泡，捕获阶段可监听所有元素）
        document.addEventListener('scroll', repositionGroupMoreMenus, true);
        // 全局 Escape：关闭各类浮层菜单（数据集 / 底图 / 分组更多 / 图层更多），与弹窗自身 Escape 互不冲突
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                closeAllMapToolMenus();
                closeAllGroupMoreMenus();
                closeAllLayerMoreMenus();
            }
        });


        // R127：面板视图 Tab 切换 + 数据集视图批量按钮
        document.querySelectorAll('.panel-tab').forEach(tab => {
            tab.addEventListener('click', () => setActivePanelView(tab.dataset.view));
        });
        const datasetAddAllBtn = document.getElementById('datasetAddAll');
        if (datasetAddAllBtn) datasetAddAllBtn.addEventListener('click', datasetAddAll);
        const datasetRemoveAllBtn = document.getElementById('datasetRemoveAll');
        if (datasetRemoveAllBtn) datasetRemoveAllBtn.addEventListener('click', datasetRemoveAll);
        // R141：图层视图底部「移除全部数据集」复用同一确认流程
        const footerRemoveAll = document.getElementById('footerRemoveAll');
        if (footerRemoveAll) footerRemoveAll.addEventListener('click', datasetRemoveAll);
        // 初次渲染：默认数据集视图
        setActivePanelView(activePanelView);
        // R124：面板底部「关于项目 / 关于作者」两个独立入口
        const aboutAuthorBtn = document.getElementById('aboutAuthorBtn');
        if (aboutAuthorBtn) aboutAuthorBtn.addEventListener('click', showAuthorModal);

        const themeBtn = document.getElementById('toggleTheme');
        if (themeBtn) {
            themeBtn.addEventListener('click', toggleTheme);
        }

        const fullscreenBtn = document.getElementById('toggleFullscreen');
        if (fullscreenBtn) {
            fullscreenBtn.addEventListener('click', toggleFullscreen);
        }

        // R85：地图左上角浮动按钮 - 图层面板开关（面板隐藏时作为唯一可见入口，位于左上方）
        const layerFab = document.getElementById('layerFab');
        if (layerFab) {
            layerFab.addEventListener('click', togglePanel);
        }

        // 侧边栏头部「收起面板」按钮：展开时可见，点击折叠侧边栏
        const sidebarCollapse = document.getElementById('sidebarCollapse');
        if (sidebarCollapse) {
            sidebarCollapse.addEventListener('click', () => setSidebarOpen(false));
        }

        // R107：底图切换改为「图标按钮」形式（置于「搜索地点」图标右侧），点击展开 #baseLayerToolMenu
        const basemapToggle = document.getElementById('basemapToggle');
        const baseLayerToolMenu = document.getElementById('baseLayerToolMenu');
        if (basemapToggle && baseLayerToolMenu) {
            initBaseLayerToolMenu(basemapToggle, baseLayerToolMenu);
        }

        // R83：定位到我的位置
        const mapToolLocate = document.getElementById('mapToolLocate');
        if (mapToolLocate) {
            mapToolLocate.addEventListener('click', locateUser);
        }

        // R83：移动端点击遮罩关闭侧边栏
        const sidebarOverlay = document.getElementById('sidebarOverlay');
        if (sidebarOverlay) {
            sidebarOverlay.addEventListener('click', () => setSidebarOpen(false));
        }

        // R86：侧边栏宽度拖拽调节（桌面端）
        initSidebarResizer();

        // R103：侧边栏「搜索图层」——仅过滤图层，不再含地点（地点搜索已独立到右上角）
        const layerSearchInput = document.getElementById('layerSearch');
        const layerSearchClear = document.getElementById('searchClear');
        if (layerSearchInput) {
            layerSearchInput.addEventListener('input', function(e) {
                searchKeyword = e.target.value.trim();
                applySearchFilter();
                if (layerSearchClear) layerSearchClear.style.display = searchKeyword ? 'block' : 'none';
            });
            layerSearchInput.addEventListener('keydown', function(e) {
                if (e.key === 'Escape') layerSearchInput.blur();
            });
        }
        if (layerSearchClear) {
            layerSearchClear.addEventListener('click', function() {
                if (layerSearchInput) {
                    layerSearchInput.value = '';
                    layerSearchInput.dispatchEvent(new Event('input'));
                    layerSearchInput.focus();
                }
            });
        }

        // R106：地点搜索点击后的「高亮 + 属性弹窗」改由 LayerManager.flashFeature 实现
        // （以要素真实几何闪烁描边并弹出属性，而非叠加独立点标记）。见下方点击处理。
        // R103/R105：把地点搜索逻辑封装为可复用函数，从侧边栏解耦，挂到右上角独立图标按钮
        function setupPlaceSearch(inputEl, resultsEl) {
            if (!inputEl || !resultsEl) return;
            const container = inputEl.closest('.place-search-floating') || inputEl.parentElement;
            const clearBtn = container ? container.querySelector('.place-search-clear') : null;
            const toggleBtn = container ? container.querySelector('.place-search-icon-btn') : null;
            let debounce = null;
            function hideResults() {
                resultsEl.classList.remove('open');
                resultsEl.innerHTML = '';
            }
            function openSearch() {
                if (!container) return;
                container.classList.add('open');
                if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
                setTimeout(() => inputEl.focus(), 60);
                // R107：若已有关键词（如再次打开），立即呈现结果（输入即搜索，无需回车）
                const cur = inputEl.value.trim();
                if (cur) render(cur);
            }
            function closeSearch() {
                if (!container) return;
                container.classList.remove('open');
                if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
                hideResults();
                // R109：折叠（收起）搜索框后自动清空已输入的文本
                inputEl.value = '';
                if (clearBtn) clearBtn.style.display = 'none';
            }
            async function render(keyword) {
                const value = String(keyword || '').trim();
                if (!value) { hideResults(); return; }
                const index = await buildSearchIndex();
                // 异步竞态防护：索引建好前关键词已被清空/更换则放弃本次渲染
                if (inputEl.value.trim() !== value) return;
                const matched = rankPlaceMatches(index, value, 8);
                if (!matched.length) { hideResults(); return; }
                resultsEl.innerHTML =
                    `<div class="place-search-head">地点 · ${matched.length} 个结果（点击定位）</div>` +
                    matched.map((m, i) =>
                        `<div class="place-search-item" data-idx="${i}" role="option"><i class="fas fa-map-marker-alt"></i><span class="place-search-name">${escapeHtml(m.name)}</span><span class="place-search-group">${escapeHtml(m.group)}</span></div>`
                    ).join('');
                resultsEl.classList.add('open');
                resultsEl.querySelectorAll('.place-search-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const m = matched[parseInt(item.dataset.idx, 10)];
                    if (m && m.bounds) {
                        MapManager.fitBounds(m.bounds, { padding: [60, 60], maxZoom: 15 });
                    }
                    // R106：以要素真实几何高亮闪烁 3s 并弹出属性（而非叠加一个点）
                    if (m && m.feature) {
                        // R110：选中后闪烁该位置，并触发与「点击地图要素」一致的效果（高亮描边 + 属性弹窗）
                        LayerManager.flashFeature(m.feature, {
                            title: m.name,
                            sub: `${m.layerName || ''} · ${m.group || ''}`,
                            duration: 3000,
                        });
                    }
                    // R115：定位后收起结果下拉（不再常驻），避免「弹出的内容不消失」（用户反馈）
                    resultsEl.querySelectorAll('.place-search-item.selected').forEach(el => el.classList.remove('selected'));
                    hideResults();
                    inputEl.focus();
                });
                });
            }
            if (toggleBtn) {
                toggleBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    if (!container.classList.contains('open')) {
                        openSearch();
                    } else {
                        closeSearch();
                    }
                });
            }
            inputEl.addEventListener('input', function(e) {
                const v = e.target.value.trim();
                if (clearBtn) clearBtn.style.display = v ? 'block' : 'none';
                clearTimeout(debounce);
                if (!v) { hideResults(); return; }
                // R107：输入即搜索（防抖），修改文本时实时刷新结果，无需按回车
                debounce = setTimeout(() => render(v), 160);
            });
            inputEl.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    clearTimeout(debounce);
                    render(inputEl.value);
                } else if (e.key === 'Escape') {
                    closeSearch();
                    inputEl.blur();
                }
            });
            if (clearBtn) {
                clearBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    inputEl.value = '';
                    inputEl.dispatchEvent(new Event('input'));
                    inputEl.focus();
                });
            }
            // R116：主流自动关闭行为——点击结果后下拉收起（R115 已做）；此外点击搜索组件之外
            // （地图/侧栏等任意处）即自动收起整个浮动搜索（回到图标态），与主流地图一致；
            // 搜索框内、图标按钮、结果项自身的点击均不触发（它们各自 stopPropagation 或位于容器内）。
            document.addEventListener('click', function(e) {
                if (!container || !container.classList.contains('open')) return;
                if (container.contains(e.target)) return;
                closeSearch();
            });
        }

        // R105：右上角独立地点搜索（图标按钮在右侧工具栏左侧，点击展开）
        setupPlaceSearch(document.getElementById('placeSearchInput'), document.getElementById('placeSearchResultsTop'));

        // R89：显示/隐藏所有数据集合并为单一切换键——依当前是否仍有被隐藏的数据集决定本次动作
        const datasetVisToggle = document.getElementById('datasetVisToggle');
        if (datasetVisToggle) {
            datasetVisToggle.addEventListener('click', function() {
                const allLayers = getCurrentLayers();
                if (allLayers.size === 0) {
                    showToast('暂无数据集', 'info');
                    return;
                }
                const anyHidden = [...new Set([...allLayers.values()].map(i => i.config.group))].some(g => LayerManager.isDatasetHidden(g));
                if (anyHidden) {
                    LayerManager.showAllDatasets();
                    updateButtonsState();
                    syncDatasetHiddenStates();
                    showToast('✅ 已显示所有数据集', 'success');
                } else {
                    LayerManager.hideAllDatasets();
                    updateButtonsState();
                    syncDatasetHiddenStates();
                    showToast('⬜ 已隐藏所有数据集', 'info');
                }
            });
        }

        const zoomBtn = document.getElementById('zoomToAll');
        if (zoomBtn) {
            zoomBtn.addEventListener('click', function() {
                const allLayers = getCurrentLayers();
                if (allLayers.size === 0) {
                    showToast('暂无图层数据', 'info');
                    return;
                }
                const bounds = L.latLngBounds();
                let hasValid = false;
                for (const [, info] of allLayers) {
                    // R89：被隐藏数据集的图层不在地图，跳过（即使其个体显隐为可见）
                    if (info.visible && !LayerManager.isDatasetHidden(info.config.group) && info.layer.getBounds().isValid()) {
                        bounds.extend(info.layer.getBounds());
                        hasValid = true;
                    }
                }
                if (hasValid) {
                    MapManager.fitBounds(bounds);
                    showToast('已缩放至全部可见图层', 'success');
                } else {
                    showToast('没有可见的数据图层', 'info');
                }
            });
        }

        // R93：清除测量按钮状态——仅当地图上存在测量内容时可用。
        // MeasureTools 在每次测量图形增删后广播 'lyc:measurechange'（detail.count），
        // 此处切换禁用态与提示文案；初始无内容即禁用
        const updateClearMeasureBtn = (count) => {
            const btn = document.querySelector('.map-tools .measure-btn[data-tool="clear"]');
            if (!btn) return;
            const has = Number(count) > 0;
            btn.disabled = !has;
            btn.dataset.tooltip = has ? '清除测量' : '暂无测量内容';
        };
        document.addEventListener('lyc:measurechange', e => updateClearMeasureBtn(e.detail && e.detail.count));
        updateClearMeasureBtn(0);

        const expandAllBtn = document.getElementById('expandAllGroups');
        if (expandAllBtn) {
            expandAllBtn.addEventListener('click', function() {
                setAllGroupsCollapsed(false);
            });
        }

        const collapseAllBtn = document.getElementById('collapseAllGroups');
        if (collapseAllBtn) {
            collapseAllBtn.addEventListener('click', function() {
                setAllGroupsCollapsed(true);
            });
        }

        // ===== 图层样式配置弹窗 =====
        const styleModal = document.getElementById('styleModal');
        if (styleModal) {
            styleModal.addEventListener('click', function(e) {
                if (e.target === styleModal) closeStylePanel();
            });
            const closeBtn = document.getElementById('styleModalClose');
            if (closeBtn) closeBtn.addEventListener('click', closeStylePanel);
            const doneBtn = document.getElementById('styleModalDone');
            if (doneBtn) doneBtn.addEventListener('click', function() {
                // R110：点击「完成」才把预览中的样式写入地图
                if (stylePanelLayerId && pendingStyle) {
                    LayerManager.updateLayerStyle(stylePanelLayerId, pendingStyle);
                }
                closeStylePanel();
            });
            const resetBtn = document.getElementById('styleReset');
            if (resetBtn) {
                resetBtn.addEventListener('click', function() {
                    if (!stylePanelLayerId) return;
                    // R110：恢复默认只重置预览工作副本，不直接改地图（由「完成」提交）
                    pendingStyle = Object.assign({}, LayerManager.getDefaultStyle(stylePanelLayerId));
                    refreshStylePanel();
                });
            }
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape' && !styleModal.hidden) closeStylePanel();
            });
        }
    }

    // ================================================================
    // R83：地图右侧工具栏 - 底图切换 / 定位 / 地点搜索
    // ================================================================

    function initBaseLayerToolMenu(btn, menu) {
        const layers = CONFIG.baseLayers;
        // R99：单选列表样式——左侧圆点 + 类型图标 + 名称，与系统原生 radio 菜单一致
        menu.innerHTML = Object.keys(layers).map(name => {
            const cfg = layers[name] || {};
            const iconClass = cfg.icon ? escapeHtml(cfg.icon) : 'fa-map';
            return `<div class="base-layer-tool-option" data-layer="${escapeHtml(name)}" role="radio" aria-checked="false">
                <span class="base-layer-radio" aria-hidden="true"></span>
                <i class="fas ${iconClass} base-layer-icon" aria-hidden="true"></i>
                <span class="base-layer-name">${escapeHtml(name)}</span>
            </div>`;
        }).join('');

        // R86：底图药丸在顶部中央，菜单在其正下方居中展开；空间不足时翻转到上方
        function positionMenu() {
            const rect = btn.getBoundingClientRect();
            const mw = menu.offsetWidth || 180;
            const mh = menu.offsetHeight || 300;
            let left = rect.left + rect.width / 2 - mw / 2;
            left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
            let top = rect.bottom + 8;
            if (top + mh > window.innerHeight - 8) {
                top = rect.top - mh - 8;
            }
            // R111：无论向上/下展开，始终夹在视口内（配合 CSS max-height: calc(100vh-24px)，能放下就不滚动）
            top = Math.max(8, Math.min(top, window.innerHeight - mh - 8));
            menu.style.left = `${Math.round(left)}px`;
            menu.style.top = `${Math.round(top)}px`;
        }

        function updateActive() {
            const current = MapManager.getCurrentBaseLayer ? MapManager.getCurrentBaseLayer() : CONFIG.defaultBaseLayer;
            menu.querySelectorAll('.base-layer-tool-option').forEach(opt => {
                const active = opt.dataset.layer === current;
                opt.classList.toggle('active', active);
                opt.setAttribute('aria-checked', String(active)); // R97：radio 语义同步
            });
        }

        menu.querySelectorAll('.base-layer-tool-option').forEach(opt => {
            opt.addEventListener('click', () => {
                MapManager.switchBaseLayer(opt.dataset.layer);
                updateActive();
                menu.classList.remove('open');
                btn.setAttribute('aria-expanded', 'false');
            });
        });

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOpen = menu.classList.contains('open');
            closeAllMapToolMenus();
            if (wasOpen) return;
            if (menu.parentElement !== document.body) {
                document.body.appendChild(menu);
            }
            updateActive();
            menu.classList.add('open');
            btn.setAttribute('aria-expanded', 'true');
            positionMenu();
        });

        document.addEventListener('click', event => {
            if (!btn.contains(event.target) && !menu.contains(event.target)) {
                menu.classList.remove('open');
                btn.setAttribute('aria-expanded', 'false');
            }
        });
    }

    function closeAllMapToolMenus() {
        const baseMenu = document.getElementById('baseLayerToolMenu');
        const baseBtn = document.getElementById('basemapToggle');
        if (baseMenu) baseMenu.classList.remove('open');
        if (baseBtn) baseBtn.setAttribute('aria-expanded', 'false');
    }

    // 当前「我的位置」标记（含脉冲动效）；进行其他地图操作或移出可视范围后自动移除
    let userLocationMarker = null;
    let userLocationMoveHandler = null;
    let userLocationOnceHandlers = [];
    function clearUserLocationMarker() {
        const map = MapManager.getMap();
        if (userLocationMarker) {
            map.removeLayer(userLocationMarker);
            userLocationMarker = null;
        }
        if (userLocationMoveHandler) {
            map.off('moveend', userLocationMoveHandler);
            userLocationMoveHandler = null;
        }
        // 解除「缩放/拖拽/点击即移除」的一次性监听，避免残留监听误删后续重新定位的标记
        userLocationOnceHandlers.forEach(h => {
            map.off('zoomstart', h);
            map.off('dragstart', h);
            map.off('click', h);
        });
        userLocationOnceHandlers = [];
        // R89：定位标记消失时同步取消按钮高亮（图标背景），作为状态区分
        const btn = document.getElementById('mapToolLocate');
        if (btn) btn.classList.remove('active');
    }

    function locateUser() {
        if (!navigator.geolocation) {
            showToast('您的浏览器不支持地理定位', 'warning');
            return;
        }
        // R89：再次点击 = 取消定位（移除标记 + 取消图标高亮）
        if (userLocationMarker) {
            clearUserLocationMarker();
            showToast('已取消定位', 'info');
            return;
        }
        showToast('正在定位您的位置…', 'info', 2000);
        navigator.geolocation.getCurrentPosition(
            pos => {
                const { latitude, longitude } = pos.coords;
                const map = MapManager.getMap();
                clearUserLocationMarker();
                // 用 divIcon 绘制带脉冲动效的定位点（中心锚定到坐标）
                const icon = L.divIcon({
                    className: 'locate-marker-wrap',
                    html: '<span class="locate-marker-dot"></span><span class="locate-marker-pulse"></span>',
                    iconSize: [0, 0],
                    iconAnchor: [0, 0],
                });
                userLocationMarker = L.marker([latitude, longitude], { icon, interactive: false, keyboard: false }).addTo(map);
                // R89：显示定位时给按钮加 .active 背景，作为「正在定位」状态区分
                const btn = document.getElementById('mapToolLocate');
                if (btn) btn.classList.add('active');
                showToast(`已定位到 经度 ${longitude.toFixed(3)}°，纬度 ${latitude.toFixed(3)}°`, 'success');
                // 飞行到达后再注册「下一次地图交互即移除」监听，避免 flyTo 自身的 zoom 动画误触发移除
                // 定位：将定位点居中到可视范围中心，并缩放到合适层级（封顶 15，与地点搜索一致）；
                // 已放大时不回缩（取当前缩放与目标的较大值），仅平移居中。
                const targetZoom = Math.min(15, (typeof map.getMaxZoom === 'function' ? map.getMaxZoom() : 19) || 15);
                const locateZoom = Math.max(map.getZoom(), targetZoom);
                map.flyTo([latitude, longitude], locateZoom, { duration: 1.1 });
                map.once('moveend', () => {
                    // 仅保留「移出可视范围即消失」一种自动消失条件：定位标记在缩放 / 平移 / 点击时不消失，
                    // 只有被移出当前视口才自动消失；再次点击定位按钮可手动取消（见 locateUser）
                    userLocationMoveHandler = () => {
                        if (userLocationMarker && !map.getBounds().contains(userLocationMarker.getLatLng())) {
                            clearUserLocationMarker();
                        }
                    };
                    map.on('moveend', userLocationMoveHandler);
                });
            },
            () => showToast('定位失败，请检查定位权限', 'error'),
            { enableHighAccuracy: true, timeout: 10000 }
        );
    }

    // 地点搜索：本地地名索引（覆盖「全部数据集」，含未加载的图层）。
    // 不再依赖被网络拦截的在线地理编码（Nominatim），保证离线 / 国内环境也可用。
    let searchIndex = null;        // 已建立的地名索引
    let searchIndexPromise = null; // 构建中的 Promise（避免重复拉取）

    // 从要素属性中挑选最适合做名称的字段值（与图层标注挑选逻辑一致：名称类字段优先）
    function pickSearchLabel(props) {
        if (!props) return '';
        const pri = ['name', '名称', '地名', 'label', 'title', '桥', '里坊', '州', '府', '路', '道'];
        for (const k of pri) {
            const v = props[k];
            if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
        }
        for (const v of Object.values(props)) {
            if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
        }
        return '';
    }

    // 由要素几何计算其经纬度边界（用于点击结果缩放到该要素，无需先加载数据集）
    function featureBounds(geometry) {
        if (!geometry) return null;
        const bounds = L.latLngBounds();
        const add = ll => { if (ll && Number.isFinite(ll[0]) && Number.isFinite(ll[1])) bounds.extend([ll[1], ll[0]]); };
        const walk = coord => {
            if (coord && typeof coord[0] === 'number') add(coord);
            else if (Array.isArray(coord)) coord.forEach(walk);
        };
        if (geometry.type === 'GeometryCollection') {
            (geometry.geometries || []).forEach(sub => {
                const b = featureBounds(sub);
                if (b) bounds.extend(b);
            });
        } else if (geometry.coordinates) {
            walk(geometry.coordinates);
        }
        return bounds.isValid() ? bounds : null;
    }

    // 构建地名索引：拉取所有数据集的 geojson，提取每个要素的名称与边界并缓存
    let fileProtocolWarned = false;
    async function buildSearchIndex() {
        if (searchIndex) return searchIndex;
        if (searchIndexPromise) return searchIndexPromise;
        searchIndexPromise = (async () => {
            const items = [];
            const datasets = (typeof DataScanner !== 'undefined' && DataScanner.getDatasets) ? DataScanner.getDatasets() : [];
            const sources = [];
            datasets.forEach(ds => (ds.sources || []).forEach(src => sources.push({ src, group: ds.name })));
            // R97：数据集清单尚未就绪（页面刚打开、扫描未完成）时不可缓存空索引——
            // 否则首次搜索若早于扫描完成，空结果会被永久缓存，之后所有搜索都「无结果」
            if (sources.length === 0) {
                searchIndex = null;
                searchIndexPromise = null;
                return [];
            }
            // R97：file:// 打开时 fetch 会被浏览器拦截，索引必然为空——给出明确提示而非静默失败
            if (location.protocol === 'file:' && !fileProtocolWarned) {
                fileProtocolWarned = true;
                showToast('⚠️ 当前以文件方式打开，搜索功能不可用——请通过本地服务器访问', 'warning');
            }
            await Promise.all(sources.map(async ({ src, group }) => {
                try {
                    // R97：单文件 8s 超时——防止个别请求挂起拖住 Promise.all 导致索引永远建不完
                    const resp = await fetch(src.url, { signal: AbortSignal.timeout(8000) });
                    if (!resp.ok) return;
                    const gj = await resp.json();
                    (gj.features || []).forEach(f => {
                        const props = f.properties || {};
                        const name = pickSearchLabel(props);
                        if (!name) return;
                        const bounds = featureBounds(f.geometry);
                        if (!bounds) return;
                        // R93：hay 纳入图层名与数据集名，支持「城门」「治所」「西苑」等按图层/数据集搜索
                        const hay = [...Object.values(props), src.name || '', group]
                            .map(v => String(v ?? '')).join(' ').toLowerCase();
                        // R106：保留原始要素对象，供点击搜索结果时在地图上高亮其真实几何并弹出属性
                        items.push({ name, group, layerName: src.name, bounds, hay, feature: f });
                    });
                } catch (e) { /* 单个文件失败不影响其它 */ }
            }));
            const seen = new Set();
            const deduped = items.filter(it => {
                const k = it.group + '|' + it.name + '|' + it.layerName;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            });
            // R97：全部文件拉取失败（如以 file:// 打开 / 服务器临时故障）时索引为空——
            // 不缓存空结果，下次搜索自动重试；否则一次网络故障会永久杀死搜索功能
            if (deduped.length === 0) {
                searchIndex = null;
                searchIndexPromise = null;
                return [];
            }
            searchIndex = deduped;
            return searchIndex;
        })();
        return searchIndexPromise;
    }

    // R97：地名匹配分级（供地图搜索与侧边栏双搜共用）——
    // 名称精确 > 名称前缀 > 名称包含 > 全属性（含图层名/数据集名）包含；同级内名称短者优先
    function rankPlaceMatches(index, keyword, limit) {
        const lower = String(keyword || '').trim().toLowerCase();
        if (!lower) return [];
        const rank = it => {
            const n = it.name.toLowerCase();
            if (n === lower) return 0;
            if (n.startsWith(lower)) return 1;
            if (n.includes(lower)) return 2;
            if (it.hay && it.hay.includes(lower)) return 3;
            return 4;
        };
        return index.filter(it => rank(it) < 4)
            .sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length)
            .slice(0, limit);
    }

    // ================================================================
    // updateLayerPanel - 去掉状态文字和删除按钮
    // ================================================================

    // hex → rgba（用于图例还原颜色不透明度）
    function hexToRgba(hex, alpha) {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return hex;
        const int = parseInt(match[1], 16);
        const r = (int >> 16) & 255, g = (int >> 8) & 255, b = int & 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    // 不透明度钳制到 0~1（非法值按 1 处理）
    function clamp01(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return 1;
        return Math.min(1, Math.max(0, num));
    }

    // 按当前样式生成图层图例（与地图显示严格对应：点大小/边线宽、线宽、填充/描边/边线不透明度）
    // 注意：不加投影阴影——阴影会让细线/小点看起来比地图实际渲染的更大
    // R111：图例色块尺寸固定——无论样式如何（线宽/点大小/描边），其在图层元素中占用的宽高不变；
    // 颜色仍如实反映样式，但符号尺寸被归一化（点 12、线 16×3、面/混合由 CSS 固定），不再缩放。
    // R111/R113：图例「块」元素固定 24×28（CSS），内部符号为固定好看的表示（不随样式大小变化），避免布局抖动
    function legendSwatchHTML(style, type) {
        if (!style) return '';
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
        const pointColor = hexToRgba(style.pointColor || '#4f6ef7', clamp01(style.pointOpacity ?? 1));
        const pointStroke = hexToRgba(style.pointStrokeColor || '#ffffff', clamp01(style.pointStrokeOpacity ?? 1));
        const lineColor = hexToRgba(style.lineColor || '#4f6ef7', clamp01(style.lineOpacity ?? 0.9));
        const fillColor = style.fillColor || '#4f6ef7';
        const fillOpacity = clamp01(style.fillOpacity ?? 0.35);
        const strokeColor = hexToRgba(style.strokeColor || fillColor, clamp01(style.strokeOpacity ?? 0.95));
        // R114：图例「块」始终固定 24×28（容器 overflow:hidden），内部符号按设置值缩放但被钳制在块内，
        // 因此改变样式时块占用尺寸不变、布局不抖动；点直径随 pointSize、线高随 lineWidth。
        if (type === 'point') {
            // 地图点真实外径 = 点大小 + 两侧边线（.point-dot 的 border 绘制在元素外部），
            // 故图例外径须按此计算，否则「点大小」与「点图例」看起来不一致（R116 修正）
            const stroke = Math.max(0, Number(style.pointStrokeWidth) || 0);
            const d = clamp((Number(style.pointSize) || 8) + stroke * 2, 4, 24); // 封顶 24 适配 24 宽块
            const sw = clamp(stroke, 0, Math.max(0, d / 2 - 0.5));               // 边线不超出圆点
            return `<span class="swatch swatch--point" style="width:${d}px;height:${d}px;background:${escapeHtml(pointColor)};box-shadow:inset 0 0 0 ${sw}px ${escapeHtml(pointStroke)};"></span>`;
        }
        if (type === 'line') {
            const lh = clamp(style.lineWidth || 2, 1.5, 24);       // 高度随线宽，封顶 24 适配 28 高块
            return `<span class="swatch swatch--line" style="width:18px;height:${lh}px;background:${escapeHtml(lineColor)};"></span>`;
        }
        // 面：沿用 R111 好看的固定符号（18×14 圆角），描边封顶 3px
        if (type === 'polygon') {
            const strokeWidth = Math.min(3, Math.max(0, Number(style.strokeWidth) || 0));
            return `<span class="swatch swatch--polygon" style="background:${escapeHtml(hexToRgba(fillColor, fillOpacity))};box-shadow:inset 0 0 0 ${strokeWidth}px ${escapeHtml(strokeColor)};"></span>`;
        }
        return `<span class="swatch swatch--mixed" style="background:linear-gradient(135deg, ${escapeHtml(hexToRgba(fillColor, fillOpacity))} 0 34%, ${escapeHtml(lineColor)} 34% 67%, ${escapeHtml(pointColor)} 67% 100%);border:1px solid ${escapeHtml(strokeColor)};"></span>`;
    }

    // 渲染单个图层条目（所有动态文本/属性均已转义）
    // 主流顺序：左侧 [拖拽把手][显隐眼睛] 图例 名称，右侧操作 [缩放][下载][标注]（样式入口=点击图例）
    function renderLayerItem(id, info) {
        const { name } = info.config;
        const { visible, featureCount, labelsVisible, labelField, data } = info;
        const isVisible = visible === true;
        const geometry = getGeometrySummary(data);
        const labelsEnabled = isVisible && !!labelField;
        const safeId = escapeHtml(id);
        const safeName = escapeHtml(name);
        const style = LayerManager.getLayerStyle(id);
        const highlighted = LayerManager.getHighlightedLayerId() === id;
        const datasetHidden = LayerManager.isDatasetHidden(info.config.group || '未分组');

        return `
            <div class="layer-item ${isVisible ? '' : 'hidden'}${highlighted ? ' highlighted' : ''}${datasetHidden ? ' dataset-hidden' : ''}" data-id="${safeId}">
                <i class="fas fa-grip-vertical drag-handle"></i>
                <button type="button" class="vis-btn ${isVisible ? 'active' : ''}" data-tooltip="${isVisible ? '隐藏图层' : '显示图层'}" aria-label="${isVisible ? '隐藏' : '显示'}${safeName}">
                    <i class="fas ${isVisible ? 'fa-eye' : 'fa-eye-slash'}"></i>
                </button>
                <span class="layer-swatch" data-tooltip="${isVisible ? '点击图例设置样式' : '图层隐藏时不可设置样式'}" role="button" aria-label="${isVisible ? '设置' + safeName + '样式' : safeName + '不可设置样式'}">${legendSwatchHTML(style, geometry.type)}</span>
                <div class="layer-info">
                    <div class="layer-name" data-tooltip="${isVisible ? '单击高亮该图层' : '图层隐藏时不可高亮'}">
                        <span>${safeName}</span>
                    </div>
                    <div class="layer-meta">
                        <span class="meta-count"><i class="fas ${geometry.icon}"></i> ${featureCount} 要素</span>
                    </div>
                </div>
                <div class="layer-actions">
                    <button type="button" class="zoom-btn" data-tooltip="${isVisible ? '缩放至该图层' : '图层隐藏时不可缩放'}" aria-label="缩放至${safeName}" ${isVisible ? '' : 'disabled'}>
                        <i class="fas fa-crosshairs"></i>
                    </button>
                    <button type="button" class="label-btn ${labelsVisible ? 'active' : ''}" data-tooltip="${!isVisible ? '图层隐藏时不可显示标注' : (labelField ? (labelsVisible ? '隐藏标注' : '显示标注') : '无可用标注字段，无法标注')}" aria-label="${labelField ? (labelsVisible ? '隐藏' + safeName + '标注' : '显示' + safeName + '标注') : safeName + '无法标注'}" ${labelsEnabled ? '' : 'disabled'}>
                        <i class="fas fa-tag"></i>
                    </button>
                    <button type="button" class="layer-more-btn" data-tooltip="更多操作" aria-label="${safeName}更多操作" aria-haspopup="menu" aria-expanded="false">
                        <i class="fas fa-ellipsis-vertical"></i>
                    </button>
                    <!-- R108：图层行「更多」菜单（打开时 portal 到 body） -->
                    <div class="layer-more-menu" role="menu" data-layer-id="${safeId}">
                        <button type="button" class="more-item layer-label-settings" role="menuitem" data-tooltip="标注设置" aria-label="${safeName}标注设置">
                            <i class="fas fa-font"></i><span>标注设置</span>
                        </button>
                        <button type="button" class="more-item layer-download" role="menuitem" data-tooltip="下载该图层数据" aria-label="下载${safeName}数据">
                            <i class="fas fa-download"></i><span>下载数据</span>
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    // 仅更新单个图层条目的状态（显隐、开关、按钮禁用态），避免全量重建列表
    function updateLayerItem(id) {
        const info = LayerManager.getLayerInfo(id);
        if (!info) return;
        const container = document.getElementById('layerList');
        if (!container) return;
        const safeId = (window.CSS && CSS.escape) ? CSS.escape(id) : id;
        const item = container.querySelector(`.layer-item[data-id="${safeId}"]`);
        if (!item) return;

        const isVisible = info.visible === true;
        const labelsEnabled = isVisible && !!info.labelField;
        const datasetHidden = LayerManager.isDatasetHidden(info.config.group || '未分组');

        item.classList.toggle('hidden', !isVisible);
        item.classList.toggle('dataset-hidden', datasetHidden);
        // 高亮状态与 LayerManager 保持同步（单击图层名触发）
        item.classList.toggle('highlighted', LayerManager.getHighlightedLayerId() === id);

        // 图层名 tooltip 同步可见性
        const nameEl = item.querySelector('.layer-name');
        if (nameEl) nameEl.dataset.tooltip = isVisible ? '单击高亮该图层' : '图层隐藏时不可高亮';

        // 图例色块跟随样式配置实时刷新；tooltip 同步可见性（点击设置样式 / 隐藏不可用）
        const swatchWrap = item.querySelector('.layer-swatch');
        if (swatchWrap) {
            swatchWrap.innerHTML = legendSwatchHTML(LayerManager.getLayerStyle(id), getLayerGeometryType(info.data));
            swatchWrap.dataset.tooltip = isVisible ? '点击图例设置样式' : '图层隐藏时不可设置样式';
        }

        // 显示/隐藏图标按钮：图标与激活态跟随可见性
        const visBtn = item.querySelector('.vis-btn');
        if (visBtn) {
            visBtn.classList.toggle('active', isVisible);
            const visIcon = visBtn.querySelector('i');
            if (visIcon) visIcon.className = `fas ${isVisible ? 'fa-eye' : 'fa-eye-slash'}`;
            visBtn.dataset.tooltip = isVisible ? '隐藏图层' : '显示图层';
        }

        const zoomBtn = item.querySelector('.zoom-btn');
        if (zoomBtn) {
            zoomBtn.disabled = !isVisible;
            zoomBtn.dataset.tooltip = isVisible ? '缩放至该图层' : '图层隐藏时不可缩放';
        }

        const labelBtn = item.querySelector('.label-btn');
        if (labelBtn) {
            labelBtn.disabled = !labelsEnabled;
            labelBtn.classList.toggle('active', isVisible && info.labelsVisible);
            labelBtn.dataset.tooltip = !isVisible ? '图层隐藏时不可显示标注'
                : (info.labelField ? (info.labelsVisible ? '隐藏标注' : '显示标注') : '无可用标注字段，无法标注');
        }
    }

    // R108：同步所有图层行的 dataset-hidden 禁用态（数据集显隐切换后调用）
    function syncDatasetHiddenStates() {
        const container = document.getElementById('layerList');
        if (!container) return;
        container.querySelectorAll('.layer-item').forEach(item => {
            const id = item.dataset.id;
            if (id) updateLayerItem(id);
        });
    }

    // 应用搜索过滤：分组感知 + 搜索时强制展开折叠分组 + 无结果提示
    // 视图感知的搜索过滤：数据集视图过滤数据集行；图层视图沿用原有图层过滤
    function applyPanelSearch() {
        const kw = (searchKeyword || '').toLowerCase();
        if (activePanelView === 'datasets') {
            const list = document.getElementById('datasetList');
            if (!list) return;
            let visible = 0;
            // 分类分组感知：组内无命中则整组隐藏；搜索时强制展开分组，清空搜索后恢复折叠状态
            list.querySelectorAll('.dataset-cat').forEach(groupEl => {
                const category = groupEl.dataset.category || '';
                const catName = category.toLowerCase();
                let groupVisible = 0;
                groupEl.querySelectorAll('.dataset-row').forEach(row => {
                    const name = (row.dataset.name || '').toLowerCase();
                    // 用 data-info（完整介绍）匹配，而非列表里那句摘要，避免摘要之外的词搜不到
                    const info = (row.dataset.info || row.querySelector('.dataset-row-info')?.textContent || '').toLowerCase();
                    // 分类名也算命中：搜「古代洛阳」可列出该组全部数据集
                    const hit = !kw || name.includes(kw) || info.includes(kw) || catName.includes(kw);
                    row.style.display = hit ? '' : 'none';
                    if (hit) { visible += 1; groupVisible += 1; }
                });
                groupEl.style.display = (kw && groupVisible === 0) ? 'none' : '';
                if (kw) groupEl.classList.remove('collapsed');
                else groupEl.classList.toggle('collapsed', collapsedCategories.has(category));
            });
            let note = list.querySelector('.dataset-empty-filter');
            if (kw && visible === 0) {
                if (!note) {
                    note = document.createElement('div');
                    note.className = 'dataset-empty dataset-empty-filter';
                    note.innerHTML = '<i class="fas fa-search"></i>未找到匹配的数据集';
                    list.appendChild(note);
                }
                note.style.display = '';
            } else if (note) {
                note.style.display = 'none';
            }
            return;
        }
        // 图层视图：原逻辑
        const container = document.getElementById('layerList');
        if (!container) return;
        container.classList.toggle('searching', !!kw);
        const matched = LayerManager.filterLayers(kw);

        let note = container.querySelector('.filter-empty');
        if (kw && matched === 0) {
            if (!note) {
                note = document.createElement('div');
                note.className = 'filter-empty';
                note.innerHTML = '<i class="fas fa-search"></i>没有匹配图层';
                container.appendChild(note);
            }
        } else if (note) {
            note.remove();
        }
    }

    // 兼容旧调用：搜索过滤统一走视图感知版本
    function applySearchFilter() {
        applyPanelSearch();
    }

    // 折叠/展开数据集分组（持久化）
    function toggleGroupCollapse(groupEl) {
        const name = groupEl.dataset.group;
        const collapsed = groupEl.classList.toggle('collapsed');
        const collapseBtn = groupEl.querySelector('.layer-group-collapse');
        if (collapseBtn) collapseBtn.setAttribute('aria-expanded', String(!collapsed));
        if (collapsed) collapsedGroups.add(name);
        else collapsedGroups.delete(name);
        persistCollapsedGroups();
        updateGroupButtonsState();
    }

    // 批量折叠/展开所有数据集分组（同步 DOM 与持久化）
    function setAllGroupsCollapsed(collapsed) {
        const groups = document.querySelectorAll('#layerList .layer-group');
        if (groups.length === 0) return;
        collapsedGroups.clear();
        groups.forEach(groupEl => {
            groupEl.classList.toggle('collapsed', collapsed);
            const collapseBtn = groupEl.querySelector('.layer-group-collapse');
            if (collapseBtn) collapseBtn.setAttribute('aria-expanded', String(!collapsed));
            if (collapsed) collapsedGroups.add(groupEl.dataset.group);
        });
        persistCollapsedGroups();
        updateGroupButtonsState();
    }

    // 工具栏「展开/折叠所有数据集」按钮可用态：
    // 无分组、或已全部处于目标状态时禁用
    function updateGroupButtonsState() {
        const groups = document.querySelectorAll('#layerList .layer-group');
        const hasGroups = groups.length > 0;
        const collapsedCount = [...groups].filter(groupEl => groupEl.classList.contains('collapsed')).length;
        const expandBtn = document.getElementById('expandAllGroups');
        const collapseBtn = document.getElementById('collapseAllGroups');
        if (expandBtn) expandBtn.disabled = !hasGroups || collapsedCount === 0;
        if (collapseBtn) collapseBtn.disabled = !hasGroups || collapsedCount === groups.length;
    }

    // 分组头操作按钮可用态（R87）：数据集眼睛图标随「整组显隐」切换；
    // 数据集隐藏时整组视为无可见图层，缩放按钮禁用。各图层自身显隐状态保持不变。
    function updateGroupVisButtons(groupEl, name) {
        const infos = [...LayerManager.getLayersByGroup(name).values()];
        if (infos.length === 0) return;
        const hidden = LayerManager.isDatasetHidden(name);
        const noneVisible = infos.every(info => !info.visible);

        const eyeBtn = groupEl.querySelector('.layer-group-dataset-vis');
        if (eyeBtn) {
            const icon = eyeBtn.querySelector('i');
            if (hidden) {
                if (icon) icon.className = 'fas fa-eye-slash';
                eyeBtn.dataset.tooltip = '显示数据集';
                eyeBtn.setAttribute('aria-label', `显示数据集${name}`);
            } else {
                if (icon) icon.className = 'fas fa-eye';
                eyeBtn.dataset.tooltip = '隐藏数据集';
                eyeBtn.setAttribute('aria-label', `隐藏数据集${name}`);
            }
            eyeBtn.classList.toggle('dataset-hidden-active', hidden);
        }
        // 整组隐藏、或全部图层自身隐藏时，缩放不可用
        const zoomBtn = groupEl.querySelector('.layer-group-zoom');
        if (zoomBtn) zoomBtn.disabled = hidden || noneVisible;

        // 整组隐藏时在分组行加视觉标记（弱化显示，提示该数据集当前未上图）
        groupEl.classList.toggle('dataset-hidden', hidden);
    }

    // 缩放到指定数据集内全部可见图层的范围
    function zoomToDataset(name) {
        const bounds = L.latLngBounds();
        let hasValid = false;
        LayerManager.getLayersByGroup(name).forEach(info => {
            // R87：数据集被隐藏时其图层不在地图，不计入缩放范围
            if (!LayerManager.isDatasetHidden(name) && info.visible && info.layer.getBounds().isValid()) {
                bounds.extend(info.layer.getBounds());
                hasValid = true;
            }
        });
        if (hasValid) {
            MapManager.fitBounds(bounds);
            showToast(`已缩放至「${name}」可见图层`, 'success');
        } else {
            showToast(`「${name}」暂无可见图层`, 'info');
        }
    }

    // 收起所有分组头「更多」菜单（菜单已 portal 到 body，直接按 open 类管理）
    function closeAllGroupMoreMenus() {
        document.querySelectorAll('.layer-group-more-menu.open').forEach(menu => {
            menu.classList.remove('open');
            const groupName = menu.dataset.group;
            if (groupName) {
                const safeGroup = (window.CSS && CSS.escape) ? CSS.escape(groupName) : groupName;
                const wrap = document.querySelector(`.layer-group[data-group="${safeGroup}"] .layer-group-more`);
                const btn = wrap?.querySelector('.layer-group-more-btn');
                if (btn) {
                    btn.classList.remove('active');
                    btn.setAttribute('aria-expanded', 'false');
                }
            }
        });
    }

    // R108：关闭所有图层行的「更多」菜单，并同步按钮 active/aria 状态
    function closeAllLayerMoreMenus() {
        document.querySelectorAll('.layer-more-menu.open').forEach(menu => {
            menu.classList.remove('open');
            const layerId = menu.dataset.layerId;
            if (layerId) {
                const safeId = (window.CSS && CSS.escape) ? CSS.escape(layerId) : layerId;
                const btn = document.querySelector(`.layer-item[data-id="${safeId}"] .layer-more-btn`);
                if (btn) {
                    btn.classList.remove('active');
                    btn.setAttribute('aria-expanded', 'false');
                }
            }
        });
    }

    // 「更多」菜单定位（fixed，菜单已在 body）：右对齐按钮下方，空间不足向上展开，视口内 clamp。
    // 用 offsetWidth/offsetHeight 测量（不受展开动画 transform 影响）
    function positionMoreMenu(btn, menu) {
        if (!btn || !menu) return;
        const rect = btn.getBoundingClientRect();
        const mw = menu.offsetWidth;
        const mh = menu.offsetHeight;
        let left = rect.right - mw;
        left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
        let top = rect.bottom + 6;
        if (top + mh > window.innerHeight - 8) {
            top = Math.max(8, rect.top - mh - 6);
        }
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
    }

    // 滚动/窗口变化时让所有打开的「更多」菜单跟随按钮重新定位
    function repositionGroupMoreMenus() {
        document.querySelectorAll('.layer-group-more-menu.open').forEach(menu => {
            const groupName = menu.dataset.group;
            if (!groupName) return;
            const safeGroup = (window.CSS && CSS.escape) ? CSS.escape(groupName) : groupName;
            const btn = document.querySelector(`.layer-group[data-group="${safeGroup}"] .layer-group-more-btn`);
            if (btn) positionMoreMenu(btn, menu);
        });
    }

    // 下载单个图层数据为 GeoJSON 文件（data 为完整 FeatureCollection，含 name/crs 等）。
    // 先弹窗确认，确认后才触发下载
    async function downloadLayer(id) {
        const info = LayerManager.getLayerInfo(id);
        if (!info || !info.data || !Array.isArray(info.data.features)) {
            showToast('该图层无数据可下载', 'info');
            return;
        }
        const name = info.config.name || id;
        const ok = await showAppModal({
            icon: 'fa-download',
            title: '下载图层数据',
            message: `确认下载「${name}」的 ${info.data.features.length} 个要素数据（GeoJSON）？`,
            confirmText: '下载',
            nowrap: true,
        });
        if (!ok) return;
        const collection = { ...info.data, type: 'FeatureCollection', name };
        const blob = new Blob([JSON.stringify(collection, null, 2)], { type: 'application/geo+json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${name}.geojson`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showToast(`已导出「${name}」${info.data.features.length} 个要素`, 'success');
    }

    function updateLayerPanel() {
        const container = document.getElementById('layerList');
        if (!container) return;

        // R127：数据加载/图层变更后同步数据集视图（添加全部/移除全部、默认加载等均依赖此刷新）
        if (activePanelView === 'datasets') renderDatasetView();
        // 图层/数据集统计随图层变更实时刷新（含空态）
        updatePanelStats();

        const allLayers = getCurrentLayers();

        const hasData = allLayers.size > 0;
        updateButtonsState(hasData);

        if (allLayers.size === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-database empty-icon"></i>
                    <div class="empty-title">尚未添加数据集</div>
                    <div class="empty-desc">切换到「数据集」标签，点「+」添加全部数据集到图层，或逐条添加所需数据集</div>
                </div>
            `;
            return;
        }

        // 按数据集分组（保持图层表中的顺序 = 添加顺序 / 拖拽顺序）
        const groups = [];
        const groupIndex = new Map();
        for (const [id, info] of allLayers) {
            const name = info.config.group || '未分组';
            if (!groupIndex.has(name)) {
                groupIndex.set(name, groups.length);
                groups.push({ name, items: [] });
            }
            groups[groupIndex.get(name)].items.push([id, info]);
        }

        let html = '';
        for (const group of groups) {
            const collapsed = collapsedGroups.has(group.name);
            const safeName = escapeHtml(group.name);
            html += `
                <div class="layer-group${collapsed ? ' collapsed' : ''}" data-group="${safeName}">
                    <div class="layer-group-header" data-tooltip="${collapsed ? '展开分组' : '折叠分组'}">
                        <span class="layer-group-drag" data-tooltip="拖动调整数据集加载顺序" aria-label="拖动${safeName}调整顺序"><i class="fas fa-grip-vertical"></i></span>
                        <span class="layer-group-collapse" role="button" aria-expanded="${!collapsed}" aria-label="${collapsed ? '展开' : '折叠'}${safeName}"><i class="fas fa-chevron-down"></i></span>
                        <span class="layer-group-icon"><i class="fas fa-database"></i></span>
                        <span class="layer-group-name">${safeName}</span>
                        <span class="layer-group-count">${group.items.length}</span>
                        <button type="button" class="layer-group-dataset-vis" data-tooltip="隐藏数据集" aria-label="隐藏数据集${safeName}">
                            <i class="fas fa-eye"></i>
                        </button>
                        <button type="button" class="layer-group-vis layer-group-zoom" data-tooltip="缩放至该数据集可见图层" aria-label="缩放至${safeName}可见图层">
                            <i class="fas fa-crosshairs"></i>
                        </button>
                        <div class="layer-group-more">
                            <button type="button" class="layer-group-more-btn" aria-haspopup="menu" aria-expanded="false" data-tooltip="更多操作" aria-label="${safeName}更多操作">
                                <i class="fas fa-ellipsis-vertical"></i>
                            </button>
                            <div class="layer-group-more-menu" role="menu" data-group="${safeName}">
                                <button type="button" class="more-item layer-group-info" role="menuitem" data-tooltip="数据集介绍" aria-label="${safeName}介绍">
                                    <i class="fas fa-circle-info"></i><span>数据集介绍</span>
                                </button>
                                ${(() => {
                                    const anyLabels = group.items.some(([, info]) => info.labelsVisible);
                                    return `<button type="button" class="more-item layer-group-labels" role="menuitem" data-tooltip="${anyLabels ? '隐藏该数据集全部标注' : '显示该数据集全部标注'}" aria-label="${anyLabels ? '隐藏' : '显示'}${safeName}全部标注">
                                        <i class="fas fa-tag"></i><span>${anyLabels ? '隐藏全部标注' : '显示全部标注'}</span>
                                    </button>`;
                                })()}
                                <button type="button" class="more-item more-remove" role="menuitem" data-tooltip="删除数据集（可重新添加）" aria-label="删除数据集${safeName}">
                                    <i class="fas fa-trash-can"></i><span>删除数据集</span>
                                </button>
                            </div>
                        </div>
                    </div>
                    <div class="layer-group-items">
                        ${group.items.map(([id, info]) => renderLayerItem(id, info)).join('')}
                    </div>
                </div>
            `;
        }

        // 面板重建前清理 portal 到 body 的旧「更多」菜单（header 内模板重建后旧菜单孤立残留）
        closeAllGroupMoreMenus();
        closeAllLayerMoreMenus();
        document.querySelectorAll('.layer-group-more-menu, .layer-more-menu').forEach(menu => {
            if (menu.parentElement === document.body) menu.remove();
        });

        container.innerHTML = html;

        // ===== 绑定分组事件 =====
        container.querySelectorAll('.layer-group').forEach(groupEl => {
            const name = groupEl.dataset.group;

            // 点击分组头（按钮除外）折叠/展开
            groupEl.querySelector('.layer-group-header').addEventListener('click', function(e) {
                if (e.target.closest('button')) return;
                toggleGroupCollapse(groupEl);
                this.dataset.tooltip = groupEl.classList.contains('collapsed') ? '展开分组' : '折叠分组';
            });

            // 缩放至该数据集内可见图层范围（自动避让图层面板）
            groupEl.querySelector('.layer-group-zoom').addEventListener('click', function(e) {
                e.stopPropagation();
                zoomToDataset(name);
            });

            // R87：数据集级显隐开关（整组隐藏/显示，不改动各图层自身显隐状态）
            const datasetVisBtn = groupEl.querySelector('.layer-group-dataset-vis');
            if (datasetVisBtn) {
                datasetVisBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    LayerManager.toggleDatasetVisible(name);
                    updateButtonsState();
                    syncDatasetHiddenStates();
                    const hidden = LayerManager.isDatasetHidden(name);
                    showToast(hidden ? `已隐藏数据集「${name}」` : `已显示数据集「${name}」`, hidden ? 'info' : 'success');
                });
            }

            // 「更多」菜单：打开/收起（点击外部与滚动由全局监听关闭）
            const moreWrap = groupEl.querySelector('.layer-group-more');
            const moreBtn = moreWrap ? moreWrap.querySelector('.layer-group-more-btn') : null;
            // 闭包持有菜单引用（portal 到 body 后不能再从 wrap 内 query 到）
            const moreMenu = moreWrap ? moreWrap.querySelector('.layer-group-more-menu') : null;
            if (moreWrap && moreBtn && moreMenu) {
                moreBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    // 先记当前状态再统一关闭：若菜单已打开则本次点击 = 关闭（否则 closeAll 后 toggle 又打开，永不消失）
                    const wasOpen = moreMenu.classList.contains('open');
                    closeAllGroupMoreMenus();
                    if (wasOpen) return;
                    // portal：菜单移入 body，避免面板 backdrop-filter 劫持 fixed 定位基准
                    if (moreMenu.parentElement !== document.body) {
                        document.body.appendChild(moreMenu);
                    }
                    moreMenu.classList.add('open');
                    this.classList.add('active');
                    this.setAttribute('aria-expanded', 'true');
                    positionMoreMenu(moreBtn, moreMenu);
                });
            }

            // 菜单项：数据集介绍 / 显示或隐藏全部标注 / 删除数据集
            groupEl.querySelector('.layer-group-info')?.addEventListener('click', function(e) {
                e.stopPropagation();
                closeAllGroupMoreMenus();
                const dataset = DataScanner.getDataset(name);
                const info = dataset && dataset.info ? dataset.info : '暂无介绍';
                showAppModal({ icon: 'fa-circle-info', title: name, message: info, confirmText: '知道了', cancelText: '' });
            });
            groupEl.querySelector('.layer-group-labels')?.addEventListener('click', function(e) {
                e.stopPropagation();
                closeAllGroupMoreMenus();
                LayerManager.toggleDatasetLabels(name);
                // 刷新分组头菜单项文字与图层行按钮状态
                updateLayerPanel();
                const anyVisible = [...LayerManager.getLayersByGroup(name).values()].some(info => info.labelsVisible);
                showToast(`已${anyVisible ? '显示' : '隐藏'}「${name}」全部标注`, anyVisible ? 'success' : 'info');
            });
            groupEl.querySelector('.more-remove')?.addEventListener('click', async function(e) {
                e.stopPropagation();
                closeAllGroupMoreMenus();
                const ok = await showAppModal({
                    icon: 'fa-trash-can',
                    title: '移除数据集',
                    message: `确定移除数据集「${name}」吗？\n其图层将从地图与列表中移除，可随时重新添加。`,
                    confirmText: '移除',
                    danger: true,
                });
                if (!ok) return;
                if (LayerManager.removeDataset(name)) {
                    showToast(`已移除「${name}」`, 'info');
                }
            });
            updateGroupVisButtons(groupEl, name);

            groupEl.querySelectorAll('.layer-item').forEach(item => bindLayerItem(item, item.dataset.id));
        });

        // 面板重建后恢复当前搜索过滤
        applySearchFilter();
        updateGroupButtonsState();

        initSortable();
    }

    // 绑定单个图层行的事件（显隐开关 / 图例开样式 / 图层名高亮 / 双击缩放 / 标注 / 更多菜单）
    function bindLayerItem(item, id) {
        // R108：数据集隐藏时整行 pointer-events:none 已禁用，但事件绑定仍额外校验
        function isLayerUsable() {
            const info = LayerManager.getLayerInfo(id);
            return info && info.visible && !LayerManager.isDatasetHidden(info.config.group || '未分组');
        }

        // 单击图例图标：打开该图层样式设置（图层隐藏或数据集隐藏时不可用）
        const swatch = item.querySelector('.layer-swatch');
        if (swatch) {
            swatch.addEventListener('click', function(e) {
                e.stopPropagation();
                if (!isLayerUsable()) return;
                openStylePanel(id);
            });
        }
        // R108：只有点击图层名本身才高亮闪烁；不再在整行上触发
        const nameEl = item.querySelector('.layer-name');
        if (nameEl) {
            nameEl.addEventListener('click', function(e) {
                e.stopPropagation();
                LayerManager.setLayerHighlight(id);
            });
        }
        // 双击图层行（按钮除外）：缩放至该图层并高亮闪烁；图层隐藏或数据集隐藏时不可用
        item.addEventListener('dblclick', function(e) {
            if (e.target.closest('button, input, label, .drag-handle, .layer-swatch, .layer-more-menu')) return;
            if (!isLayerUsable()) return;
            LayerManager.zoomToLayer(id);
            LayerManager.setLayerHighlight(id);
        });

        // 显示/隐藏图标按钮：直接切换图层可见性
        const visBtn = item.querySelector('.vis-btn');
        if (visBtn) {
            visBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                LayerManager.toggleLayer(id);
            });
        }

        const zoomBtn = item.querySelector('.zoom-btn');
        if (zoomBtn) {
            zoomBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (!isLayerUsable()) return;
                LayerManager.zoomToLayer(id);
            });
        }

        // R108：图层行「更多」菜单：打开/收起 + 菜单项（标注设置 / 下载数据）
        const moreBtn = item.querySelector('.layer-more-btn');
        const moreMenu = item.querySelector('.layer-more-menu');
        if (moreBtn && moreMenu) {
            moreBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                const wasOpen = moreMenu.classList.contains('open');
                closeAllLayerMoreMenus();
                if (wasOpen) return;
                if (moreMenu.parentElement !== document.body) document.body.appendChild(moreMenu);
                moreMenu.classList.add('open');
                moreBtn.classList.add('active');
                moreBtn.setAttribute('aria-expanded', 'true');
                positionMoreMenu(moreBtn, moreMenu);
            });
        }
        if (moreMenu) {
            const labelSettingsBtn = moreMenu.querySelector('.layer-label-settings');
            if (labelSettingsBtn) {
                labelSettingsBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    closeAllLayerMoreMenus();
                    openLabelPanel(id);
                });
            }
            const downloadBtn = moreMenu.querySelector('.layer-download');
            if (downloadBtn) {
                downloadBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    closeAllLayerMoreMenus();
                    downloadLayer(id);
                });
            }
        }

        const labelBtn = item.querySelector('.label-btn');
        if (labelBtn && !labelBtn.disabled) {
            labelBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                e.preventDefault();
                const info = LayerManager.getLayerInfo(id);
                if (!info || !info.visible || LayerManager.isDatasetHidden(info.config.group || '未分组')) return;
                LayerManager.toggleLabels(id);
            });
        }
    }

    function updateLegend() {
        const container = document.getElementById('legendList');
        if (!container) return;

        const allLayers = LayerManager.getAllLayers();
        if (allLayers.size === 0) {
            container.innerHTML = `
                <span style="font-size:12px;color:var(--text-secondary);opacity:0.6;">
                    <i class="fas fa-minus-circle"></i> 暂无可见图层
                </span>
            `;
            return;
        }

        let html = '';
        for (const [id, info] of allLayers) {
            if (info.visible) {
                const { name, color } = info.config;
                const style = LayerManager.getLayerStyle(id);
                const primary = LayerManager.getThemeColor(style, getLayerGeometryType(info.data)) || color;
                html += `
                    <div class="legend-item">
                        <span class="legend-color" style="background:${escapeHtml(primary)};"></span>
                        ${escapeHtml(name)}
                    </div>
                `;
            }
        }
        container.innerHTML = html || '<span style="font-size:12px;color:var(--text-secondary);opacity:0.6;">暂无可见图层</span>';
    }

    function toggleTheme() {
        isDark = !isDark;
        document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
        try { localStorage.setItem('mapTheme', isDark ? 'dark' : 'light'); } catch (error) { /* 存储失败不阻塞主题切换 */ }

        const icon = document.querySelector('#toggleTheme i');
        if (icon) {
            icon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
        }
        // R90：主题与底图联动——暗色用暗黑底图、亮色用冷色底图
        applyBasemapForTheme();
        // R95：主题切换 → 非原生暗色底图同步套/摘瓦片暗色滤镜
        if (MapManager.refreshTilesThemeFilter) MapManager.refreshTilesThemeFilter();
        showToast(isDark ? '🌙 切换到暗色主题' : '☀️ 切换到亮色主题', 'info');
    }

    function toggleFullscreen() {
        const el = document.documentElement;
        if (!document.fullscreenElement) {
            const request = el.requestFullscreen?.() || el.webkitRequestFullscreen?.();
            Promise.resolve(request).catch(() => showToast('无法进入全屏模式', 'error'));
        } else {
            const exit = document.exitFullscreen?.() || document.webkitExitFullscreen?.();
            Promise.resolve(exit).catch(() => showToast('无法退出全屏模式', 'error'));
        }
        syncFullscreenState();
    }

    function syncFullscreenState() {
        isFullscreen = Boolean(document.fullscreenElement);
        const icon = document.querySelector('#toggleFullscreen i');
        if (icon) {
            icon.className = isFullscreen ? 'fas fa-compress' : 'fas fa-expand';
        }
    }

    function isMobile() {
        return window.innerWidth <= 768;
    }

    function isSidebarOpen() {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return false;
        return isMobile() ? sidebar.classList.contains('sidebar--open') : !sidebar.classList.contains('sidebar--collapsed');
    }

    function setSidebarOpen(open) {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        if (isMobile()) {
            sidebar.classList.toggle('sidebar--open', open);
            sidebar.classList.remove('sidebar--collapsed');
        } else {
            sidebar.classList.toggle('sidebar--collapsed', !open);
            sidebar.classList.remove('sidebar--open');
        }
        const overlay = document.getElementById('sidebarOverlay');
        if (overlay) overlay.classList.toggle('active', isMobile() && open);
        applyPanelButtonState();
        // 桌面端折叠/展开会改变地图容器宽度（侧边栏滑出/滑入），必须通知 Leaflet 重新计算尺寸，
        // 否则瓦片、缩放控件与鼠标点击→经纬度映射会错位。移动端为抽屉覆盖、地图尺寸不变，无需处理。
        if (!isMobile() && MapManager.invalidateSize) {
            let done = false;
            const refresh = () => {
                if (done) return;
                done = true;
                sidebar.removeEventListener('transitionend', refresh);
                MapManager.invalidateSize();
                if (MapManager.repositionBottomHud) MapManager.repositionBottomHud();
            };
            sidebar.addEventListener('transitionend', refresh);
            setTimeout(refresh, 360); // 兜底：过渡被禁用（reduced-motion）或无 transitionend 时仍校准
        }
    }

    function togglePanel() {
        setSidebarOpen(!isSidebarOpen());
    }

    // R86：侧边栏宽度可拖拽调节（桌面端，右缘手柄）。拖动时实时更新 --sidebar-width（侧边栏与地图区共享该变量），
    // 并临时关闭过渡以免拖拽卡顿；松手后持久化到 localStorage 并通知 Leaflet 重算尺寸。
    function initSidebarResizer() {
        const resizer = document.getElementById('sidebarResizer');
        const sidebar = document.getElementById('sidebar');
        if (!resizer || !sidebar) return;

        let dragging = false;
        let startX = 0;
        let startW = 0;

        resizer.addEventListener('pointerdown', (e) => {
            if (isMobile()) return; // 移动端为抽屉，不拖拽
            dragging = true;
            startX = e.clientX;
            startW = sidebar.getBoundingClientRect().width;
            resizer.setPointerCapture(e.pointerId);
            document.body.classList.add('resizing');
            e.preventDefault();
        });

        resizer.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            let newW = startW + (e.clientX - startX);
            newW = Math.max(220, Math.min(newW, 560));
            document.documentElement.style.setProperty('--sidebar-width', newW + 'px');
        });

        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            document.body.classList.remove('resizing');
            try { resizer.releasePointerCapture(e.pointerId); } catch (_) {}
            const w = Math.round(sidebar.getBoundingClientRect().width);
            try { localStorage.setItem('lyc_sidebar_width', String(w)); } catch (_) {}
            if (MapManager.invalidateSize) MapManager.invalidateSize();
            if (MapManager.repositionBottomHud) MapManager.repositionBottomHud();
        };
        resizer.addEventListener('pointerup', endDrag);
        resizer.addEventListener('pointercancel', endDrag);
    }

    // 同步「图层面板」浮动按钮与「头部收起」按钮的状态，与侧边栏开合保持一致
    function applyPanelButtonState() {
        const hidden = !isSidebarOpen();
        // 左上角浮动「图层」按钮（FAB）：面板展开时隐藏（面板自身可见，无需重复入口），
        // 面板收起/抽屉关闭时显示并高亮 active（主流地图惯例：点击可重新展开面板）
        const layerFab = document.getElementById('layerFab');
        if (layerFab) {
            const icon = layerFab.querySelector('i');
            // R87：折叠面板用 < (chevron-left)，展开面板用 > (chevron-right)，图标与语义一致；FAB 背景在 CSS 中已加强调色
            if (icon) icon.className = 'fas fa-chevron-right';
            layerFab.classList.toggle('active', !hidden);
            layerFab.style.display = hidden ? '' : 'none';
            layerFab.dataset.tooltip = '展开面板';
            layerFab.setAttribute('aria-label', '展开面板');
            layerFab.setAttribute('aria-expanded', String(!hidden));
        }
        // 头部收起按钮：面板展开时显示，收起（已滑出视口）时隐藏
        const collapseBtn = document.getElementById('sidebarCollapse');
        if (collapseBtn) {
            collapseBtn.style.display = hidden ? 'none' : '';
            collapseBtn.setAttribute('aria-expanded', String(!hidden));
        }
    }

    // ================================================================
    // 图层样式配置面板
    // ================================================================

    // ================================================================
    // 自定义取色器（应用内调色板，样式跟随亮/暗主题；替代原生 <input type="color">，
    // 避免系统取色器弹层被遮挡、且与界面主题不一致的问题）
    // ================================================================
    const CP_PRESETS = [
        '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
        '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#3b82f6',
        '#4f6ef7', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
        '#ec4899', '#78716c', '#334155', '#64748b', '#ffffff',
    ];
    let activeColorPicker = null;

    // 规范化 hex（#rgb → #rrggbb；非法值回退默认蓝）
    function normalizeHex(value) {
        let hex = String(value ?? '').trim().replace(/^#/, '');
        if (/^[0-9a-f]{3}$/i.test(hex)) {
            hex = hex.split('').map(ch => ch + ch).join('');
        }
        if (!/^[0-9a-f]{6}$/i.test(hex)) hex = '4f6ef7';
        return `#${hex.toLowerCase()}`;
    }

    function rgbToHex(r, g, b) {
        const to2 = n => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
        return `#${to2(r)}${to2(g)}${to2(b)}`;
    }

    function hsvToHex(h, s, v) {
        const c = v * s;
        const hp = (((h % 360) + 360) % 360) / 60;
        const x = c * (1 - Math.abs(hp % 2 - 1));
        let r = 0, g = 0, b = 0;
        if (hp < 1) [r, g, b] = [c, x, 0];
        else if (hp < 2) [r, g, b] = [x, c, 0];
        else if (hp < 3) [r, g, b] = [0, c, x];
        else if (hp < 4) [r, g, b] = [0, x, c];
        else if (hp < 5) [r, g, b] = [x, 0, c];
        else [r, g, b] = [c, 0, x];
        const m = v - c;
        return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
    }

    function hexToHsv(hex) {
        const norm = normalizeHex(hex).slice(1);
        const r = parseInt(norm.slice(0, 2), 16) / 255;
        const g = parseInt(norm.slice(2, 4), 16) / 255;
        const b = parseInt(norm.slice(4, 6), 16) / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        if (d > 0) {
            if (max === r) h = 60 * (((g - b) / d) % 6);
            else if (max === g) h = 60 * ((b - r) / d + 2);
            else h = 60 * ((r - g) / d + 4);
        }
        if (h < 0) h += 360;
        return { h, s: max === 0 ? 0 : d / max, v: max };
    }

    function closeColorPicker() {
        if (!activeColorPicker) return;
        const { popover, onGlobalPointerDown, onKeydown } = activeColorPicker;
        document.removeEventListener('pointerdown', onGlobalPointerDown, true);
        document.removeEventListener('keydown', onKeydown, true);
        popover.remove();
        activeColorPicker = null;
    }

    function openColorPicker(btn, id, opts) {
        closeColorPicker();
        const key = btn.dataset.colorKey;
        const mode = (opts && opts.mode === 'label') ? 'label' : 'style';
        if (!key) return;
        let initialHex;
        if (mode === 'label') {
            initialHex = normalizeHex(btn.dataset.color || (key === 'textColor' ? '#334155' : '#ffffff'));
        } else {
            const style = LayerManager.getLayerStyle(id);
            if (!style) return;
            initialHex = normalizeHex(style[key]);
        }

        let hsv = hexToHsv(initialHex);

        const popover = document.createElement('div');
        popover.className = 'color-picker-pop';
        popover.innerHTML = `
            <div class="cp-sv"><div class="cp-sv-cursor"></div></div>
            <input type="range" class="cp-hue" min="0" max="360" step="1" aria-label="色相" />
            <div class="cp-presets"></div>
            <div class="cp-hex-row">
                <span class="cp-hex-label">HEX</span>
                <input type="text" class="cp-hex-input" maxlength="7" spellcheck="false" />
            </div>
        `;
        document.body.appendChild(popover);

        const svArea = popover.querySelector('.cp-sv');
        const svCursor = popover.querySelector('.cp-sv-cursor');
        const hueRange = popover.querySelector('.cp-hue');
        const presetsBox = popover.querySelector('.cp-presets');
        const hexInput = popover.querySelector('.cp-hex-input');

        presetsBox.innerHTML = CP_PRESETS.map(hex =>
            `<button type="button" class="cp-preset" data-hex="${hex}" style="background:${hex};" aria-label="选择颜色 ${hex}"></button>`
        ).join('');

        // 实时应用到图层样式与按钮显示；取色器内 HEX 输入框同步跟随
        // （用户正在输入时不回写，避免打断输入）
        const applyColor = function(hex) {
            // R110：只写入预览工作副本 + 刷新示例，点击「完成」才真正应用
            if (mode === 'label') {
                if (!pendingLabel) return;
                pendingLabel[key] = hex;
                btn.dataset.color = hex;
                const swatch = btn.querySelector('.color-field-swatch');
                if (swatch) swatch.style.background = hex;
                const hexEl = btn.querySelector('.hex-val') || document.querySelector(`[data-hex-for="${key}"]`);
                if (hexEl) hexEl.textContent = hex.toUpperCase();
                const body = document.getElementById('labelSettingsBody');
                if (body) updateLabelPreview(body);
                return;
            }
            pendingStyle[key] = hex;
            btn.dataset.color = hex;
            const swatch = btn.querySelector('.color-field-swatch');
            if (swatch) swatch.style.background = hex;
            const hexEl = document.querySelector(`[data-hex-for="${key}"]`);
            if (hexEl) hexEl.textContent = hex.toUpperCase();
            if (document.activeElement !== hexInput) {
                hexInput.value = hex.toUpperCase();
            }
            const body = document.getElementById('styleModalBody');
            if (body) updateStylePreview(body);
            syncStyleResetState(id);
        };

        const render = function() {
            svArea.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(hsv.h, 1, 1)})`;
            svCursor.style.left = `${hsv.s * 100}%`;
            svCursor.style.top = `${(1 - hsv.v) * 100}%`;
            svCursor.style.background = hsvToHex(hsv.h, hsv.s, hsv.v);
            hueRange.value = String(Math.round(hsv.h));
        };

        // 定位：按钮下方优先，空间不足翻到上方，整体限制在视口内（fixed 定位不受弹窗裁剪/遮挡）
        popover.style.visibility = 'hidden';
        const popRect = popover.getBoundingClientRect();
        const rect = btn.getBoundingClientRect();
        let left = Math.min(Math.max(8, rect.left), window.innerWidth - popRect.width - 8);
        let top = rect.bottom + 8;
        if (top + popRect.height > window.innerHeight - 8) {
            top = Math.max(8, rect.top - popRect.height - 8);
        }
        popover.style.left = `${Math.round(left)}px`;
        popover.style.top = `${Math.round(top)}px`;
        popover.style.visibility = '';

        // SV 面板拖拽选色
        const pickFromSv = function(event) {
            const box = svArea.getBoundingClientRect();
            hsv.s = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
            hsv.v = 1 - Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
            render();
            applyColor(hsvToHex(hsv.h, hsv.s, hsv.v));
        };
        svArea.addEventListener('pointerdown', function(event) {
            event.preventDefault();
            svArea.setPointerCapture(event.pointerId);
            pickFromSv(event);
            const onMove = e => pickFromSv(e);
            const onUp = function() {
                svArea.removeEventListener('pointermove', onMove);
                svArea.removeEventListener('pointerup', onUp);
            };
            svArea.addEventListener('pointermove', onMove);
            svArea.addEventListener('pointerup', onUp);
        });

        hueRange.addEventListener('input', function() {
            hsv.h = parseFloat(this.value) || 0;
            render();
            applyColor(hsvToHex(hsv.h, hsv.s, hsv.v));
        });

        presetsBox.addEventListener('click', function(event) {
            const preset = event.target.closest('.cp-preset');
            if (!preset) return;
            hsv = hexToHsv(preset.dataset.hex);
            hexInput.value = preset.dataset.hex.toUpperCase();
            render();
            applyColor(preset.dataset.hex);
        });

        hexInput.value = normalizeHex(initialHex).toUpperCase();
        const commitHex = function() {
            const hex = normalizeHex(hexInput.value);
            hexInput.value = hex.toUpperCase();
            hsv = hexToHsv(hex);
            render();
            applyColor(hex);
        };
        hexInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                commitHex();
                hexInput.blur();
            }
        });
        hexInput.addEventListener('input', function() {
            const raw = this.value.trim();
            if (/^#?[0-9a-f]{6}$/i.test(raw)) {
                const hex = normalizeHex(raw);
                hsv = hexToHsv(hex);
                render();
                applyColor(hex);
            }
        });
        hexInput.addEventListener('blur', commitHex);

        // 点击取色器外部 / 按 Escape 关闭
        const onGlobalPointerDown = function(event) {
            if (!popover.contains(event.target) && !btn.contains(event.target)) closeColorPicker();
        };
        const onKeydown = function(event) {
            if (event.key === 'Escape') closeColorPicker();
        };
        document.addEventListener('pointerdown', onGlobalPointerDown, true);
        document.addEventListener('keydown', onKeydown, true);

        render();
        activeColorPicker = { popover, btn, onGlobalPointerDown, onKeydown };
    }

    function colorField(key, label, value) {
        const hex = normalizeHex(value);
        return `
            <div class="style-field">
                <label>${label}</label>
                <div class="style-control">
                    <button type="button" class="color-field-btn" data-color-key="${key}" data-color="${escapeHtml(hex)}">
                        <span class="color-field-swatch" style="background:${escapeHtml(hex)};"></span>
                        <span class="hex-val" data-hex-for="${key}">${escapeHtml(hex.toUpperCase())}</span>
                        <i class="fas fa-chevron-down color-field-caret"></i>
                    </button>
                </div>
            </div>
        `;
    }

    // R111/R112：标注面板的颜色字段——与图例/样式配置使用同一套自定义取色器 UI（.color-field-btn + 弹层）
    // R112：移除「默认」按钮（颜色始终为具体取值，保持与本项目风格一致）
    function labelColorField(key, label, value) {
        // R114：文字颜色空值默认取图例色（labelLegendColor），扫边颜色无图例概念则默认白
        const def = key === 'textColor' ? (labelLegendColor || '#334155') : '#ffffff';
        const hex = normalizeHex(value || def);
        return `
            <div class="style-field">
                <label>${label}</label>
                <div class="style-control">
                    <button type="button" class="color-field-btn" data-color-key="${key}" data-color="${escapeHtml(hex)}" data-label-color="1">
                        <span class="color-field-swatch" style="background:${escapeHtml(hex)};"></span>
                        <span class="hex-val" data-hex-for="${key}">${escapeHtml(hex.toUpperCase())}</span>
                        <i class="fas fa-chevron-down color-field-caret"></i>
                    </button>
                </div>
            </div>`;
    }

    // R114：自定义下拉组件（替代原生 select，彻底解决原生下拉的 OS 样式/悬停不可定制问题）。
    // options: [{value, text}]；customSelectHTML 仅产出结构，绑定见 bindCustomSelect。
    function customSelectHTML(id, options, currentValue) {
        const cur = options.find(o => o.value === currentValue);
        const curText = cur ? cur.text : (options[0] ? options[0].text : '');
        const opts = options.map(o =>
            `<div class="custom-select-option ${o.value === currentValue ? 'selected' : ''}" data-value="${escapeHtml(o.value)}" role="option" aria-selected="${o.value === currentValue}">${escapeHtml(o.text)}</div>`
        ).join('');
        return `
            <div class="custom-select" id="${id}" data-value="${escapeHtml(currentValue)}" tabindex="0">
                <div class="custom-select-trigger">
                    <span class="custom-select-value">${escapeHtml(curText)}</span>
                    <i class="fas fa-chevron-down custom-select-caret"></i>
                </div>
                <div class="custom-select-options" role="listbox">${opts}</div>
            </div>`;
    }

    function rangeField(key, label, value, min, max, step, unit) {
        const val = Math.round(Number(value) * 100) / 100;
        return `
            <div class="style-field">
                <label>${label}</label>
                <div class="style-control">
                    <input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${val}" data-unit="${unit}" />
                    <span class="range-val" data-val-for="${key}">${val}${unit}</span>
                </div>
            </div>
        `;
    }

    // 不透明度字段：滑块以 0~100% 显示，存储为 0~1
    function opacityField(key, label, value) {
        const percent = Math.round(clamp01(value) * 100);
        return rangeField(key, label, percent, 0, 100, 1, '%');
    }

    // 生成一个样式分组：标题 + 字段列表
    function styleGroup(title, fields) {
        return `
            <div class="style-group">
                <div class="style-group-title">${title}</div>
                <div class="style-group-fields">${fields.join('')}</div>
            </div>
        `;
    }

    // 按几何类型生成分组样式控件。
    // 命名约定：描边类设置（面边界/点边线/线）一律统称「线条」；所有颜色均可配置不透明度。
    // 面 → 填充（颜色/不透明度）+ 线条（颜色/不透明度/宽度）
    // 线 → 线条（颜色/不透明度/宽度）；点 → 点（颜色/不透明度/大小）+ 线条（颜色/不透明度/宽度）
    // R114：标注文字「默认」颜色 = 图层图例（主题）色；打开标注面板时按几何类型写入，预览/地图均以此为准
    let labelLegendColor = '#334155';
    let labelSelectOutsideBound = false;

    // R116：预览内容固定显示，不再支持缩放（移除 R113 滚轮缩放机制）

    // R110：示例预览 SVG（面/线/点/混合）；R112：线改为水平直线（不弯曲）
    function stylePreviewSvg(type, s) {
        const parts = [];
        if (type === 'polygon' || type === 'mixed') {
            parts.push(`<rect data-preview-fill x="24" y="22" width="112" height="46" rx="5" fill="${s.fillColor}" fill-opacity="${s.fillOpacity}" stroke="${s.strokeColor}" stroke-width="${s.strokeWidth}" stroke-opacity="${s.strokeOpacity}"/>`);
        }
        if (type === 'line' || type === 'mixed') {
            parts.push(`<path data-preview-line d="M14 45 L146 45" fill="none" stroke="${s.lineColor}" stroke-width="${s.lineWidth}" stroke-opacity="${s.lineOpacity}" stroke-linecap="round"/>`);
        }
        if (type === 'point' || type === 'mixed') {
            // 预览点的外径须与地图一致：r = (点大小 + 边线宽) / 2（SVG 描边居中，外径 = 2r + 边线宽）
            const psw = Number(s.pointStrokeWidth) || 0;
            parts.push(`<circle data-preview-point cx="80" cy="44" r="${Math.max(3, ((s.pointSize || 8) + psw) / 2)}" fill="${s.pointColor}" fill-opacity="${s.pointOpacity}" stroke="${s.pointStrokeColor}" stroke-width="${s.pointStrokeWidth}" stroke-opacity="${s.pointStrokeOpacity}"/>`);
        }
        return `<svg class="style-preview-svg" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
    }

    function buildStyleFields(type, style) {
        const groups = [];
        if (type === 'polygon' || type === 'mixed') {
            groups.push(styleGroup('填充', [
                colorField('fillColor', '颜色', style.fillColor),
                opacityField('fillOpacity', '不透明度', style.fillOpacity),
            ]));
            groups.push(styleGroup(type === 'mixed' ? '线条（边界）' : '线条', [
                colorField('strokeColor', '颜色', style.strokeColor),
                opacityField('strokeOpacity', '不透明度', style.strokeOpacity),
                rangeField('strokeWidth', '宽度', style.strokeWidth, 0, 8, 0.5, 'px'),
            ]));
        }
        if (type === 'line' || type === 'mixed') {
            groups.push(styleGroup('线条', [
                colorField('lineColor', '颜色', style.lineColor),
                opacityField('lineOpacity', '不透明度', style.lineOpacity),
                rangeField('lineWidth', '宽度', style.lineWidth, 0.5, 12, 0.5, 'px'),
            ]));
        }
        if (type === 'point' || type === 'mixed') {
            groups.push(styleGroup('点', [
                colorField('pointColor', '颜色', style.pointColor),
                opacityField('pointOpacity', '不透明度', style.pointOpacity),
                rangeField('pointSize', '大小', style.pointSize, 4, 32, 1, 'px'),
            ]));
            groups.push(styleGroup(type === 'mixed' ? '线条（点边线）' : '线条', [
                colorField('pointStrokeColor', '颜色', style.pointStrokeColor),
                opacityField('pointStrokeOpacity', '不透明度', style.pointStrokeOpacity),
                rangeField('pointStrokeWidth', '宽度', style.pointStrokeWidth, 0, 6, 0.5, 'px'),
            ]));
        }
        const preview = stylePreviewSvg(type, style);
        // R111：预览移到面板顶部，简化为轻量示例条；R113：缩放改滚轮（无按钮）
        return `
            <div class="style-preview">
                <div class="style-preview-head">预览</div>
                <div class="style-preview-stage">${preview}</div>
            </div>` + groups.join('');
    }

    // 同步样式面板内「恢复默认」按钮可用态（R110：基于预览工作副本与默认值比较）
    function syncStyleResetState(id) {
        const resetBtn = document.getElementById('styleReset');
        if (!resetBtn || !id) return;
        const def = LayerManager.getDefaultStyle(id);
        const cur = pendingStyle || LayerManager.getLayerStyle(id);
        resetBtn.disabled = def ? Object.keys(def).every(k => cur[k] === def[k]) : true;
    }

    // 绑定样式控件输入事件：R110 只写入预览工作副本 + 刷新示例，点击「完成」才真正应用
    function bindStyleInputs(body, id) {
        body.querySelectorAll('input[data-key]').forEach(input => {
            input.addEventListener('input', function() {
                const key = this.dataset.key;
                const value = parseFloat(this.value);
                const valEl = body.querySelector(`[data-val-for="${key}"]`);
                if (valEl) valEl.textContent = `${value}${this.dataset.unit || ''}`;
                // 不透明度类滑块（*Opacity）以百分比显示，统一存储为 0~1
                const stored = key.endsWith('Opacity') ? value / 100 : value;
                pendingStyle[key] = stored;
                updateStylePreview(body);
                syncStyleResetState(id);
            });
        });
        body.querySelectorAll('button[data-color-key]').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                // 再次点击同一按钮 = 收起取色器
                if (activeColorPicker && activeColorPicker.btn === this) {
                    closeColorPicker();
                    return;
                }
                openColorPicker(this, id);
            });
        });
    }

    // R110：根据 pendingStyle 实时刷新示例预览（不直接改地图）
    function updateStylePreview(body) {
        if (!pendingStyle || !body) return;
        const s = pendingStyle;
        const fillRect = body.querySelector('[data-preview-fill]');
        if (fillRect) {
            fillRect.setAttribute('fill', s.fillColor);
            fillRect.setAttribute('fill-opacity', s.fillOpacity);
            fillRect.setAttribute('stroke', s.strokeColor);
            fillRect.setAttribute('stroke-width', s.strokeWidth);
            fillRect.setAttribute('stroke-opacity', s.strokeOpacity);
        }
        const linePath = body.querySelector('[data-preview-line]');
        if (linePath) {
            linePath.setAttribute('stroke', s.lineColor);
            linePath.setAttribute('stroke-width', s.lineWidth);
            linePath.setAttribute('stroke-opacity', s.lineOpacity);
        }
        const pt = body.querySelector('[data-preview-point]');
        if (pt) {
            pt.setAttribute('fill', s.pointColor);
            pt.setAttribute('fill-opacity', s.pointOpacity);
            pt.setAttribute('stroke', s.pointStrokeColor);
            pt.setAttribute('stroke-width', s.pointStrokeWidth);
            pt.setAttribute('stroke-opacity', s.pointStrokeOpacity);
            pt.setAttribute('r', Math.max(3, ((s.pointSize || 8) + (Number(s.pointStrokeWidth) || 0)) / 2));
        }
    }

    function openStylePanel(id) {
        const info = LayerManager.getLayerInfo(id);
        if (!info) return;
        closeColorPicker();
        stylePanelLayerId = id;
        const modal = document.getElementById('styleModal');
        const title = document.getElementById('styleModalTitle');
        const sub = document.getElementById('styleModalSub');
        const body = document.getElementById('styleModalBody');
        if (!modal || !body) return;
        const geometry = getGeometrySummary(info.data);
        title.textContent = info.config.name;
        if (sub) sub.textContent = `${geometry.label}图层 · ${info.featureCount} 要素`;
        const iconEl = modal.querySelector('.style-modal-icon i');
        if (iconEl) iconEl.className = `fas ${geometry.icon}`;
        pendingStyle = Object.assign({}, LayerManager.getLayerStyle(id));
        body.innerHTML = buildStyleFields(getLayerGeometryType(info.data), pendingStyle);
        bindStyleInputs(body, id);
        updateStylePreview(body);
        syncStyleResetState(id);
        modal.hidden = false;
        document.body.classList.add('modal-open');
    }

    function closeStylePanel() {
        closeColorPicker();
        const modal = document.getElementById('styleModal');
        if (modal) modal.hidden = true;
        stylePanelLayerId = null;
        pendingStyle = null;
        document.body.classList.remove('modal-open');
    }

    function refreshStylePanel() {
        if (!stylePanelLayerId) return;
        closeColorPicker();
        const info = LayerManager.getLayerInfo(stylePanelLayerId);
        const body = document.getElementById('styleModalBody');
        if (!info || !body) return;
        body.innerHTML = buildStyleFields(getLayerGeometryType(info.data), pendingStyle);
        bindStyleInputs(body, stylePanelLayerId);
        updateStylePreview(body);
        syncStyleResetState(stylePanelLayerId);
    }

    // ---------- R106/R108：标注设置面板（全局默认值 + 每图层独立覆盖） ----------
    // 调整标注字段、文字颜色、扫边（描边）颜色/宽度、字体/字号、以及显隐。
    function buildLabelSettingsForm(settings, opts) {
        opts = opts || {};
        // 标注字段候选：仅列出该图层自身包含的字段（+ 自动）
        const fields = LayerManager.getLayerFields(opts.layerId);
        const fieldOpts = [{ value: '', text: '自动（每图层默认字段）' }]
            .concat(fields.map(f => ({ value: f, text: f })));
        const fontOpts = [
            { value: '', text: '默认字体' },
            { value: '"Microsoft YaHei","PingFang SC",sans-serif', text: '微软雅黑' },
            { value: '"SimSun","Songti SC",serif', text: '宋体' },
            { value: '"SimHei","Heiti SC",sans-serif', text: '黑体' },
            { value: '"KaiTi","Kaiti SC",serif', text: '楷体' },
            { value: '"FangSong","STFangsong",serif', text: '仿宋' },
            { value: 'serif', text: '衬线 Serif' },
            { value: 'monospace', text: '等宽 Mono' },
        ];
        const fontSize = settings.fontSize || 12;
        const haloWidth = (settings.haloWidth === '' || settings.haloWidth == null) ? 2 : settings.haloWidth;
        const textOpacity = (settings.textOpacity === '' || settings.textOpacity == null) ? 1 : Number(settings.textOpacity);
        const haloOpacity = (settings.haloOpacity === '' || settings.haloOpacity == null) ? 1 : Number(settings.haloOpacity);
        const textOpacityPct = Math.round(textOpacity * 100);
        const haloOpacityPct = Math.round(haloOpacity * 100);
        const showChecked = !!opts.show;
        // R109/R110：统一文案为「显示标注」（去掉冗余前缀与后面的显示/隐藏动态文本）
        const showLabel = '显示标注';
        const labelPreview = `
            <div class="style-preview">
                <div class="style-preview-head">预览</div>
                <div class="style-preview-stage">
                    <span class="label-preview-sample" data-label-preview>示例标注</span>
                </div>
            </div>`;
        return `
            ${labelPreview}
            <div class="style-group">
                <div class="style-group-title">标注内容</div>
                <div class="style-group-fields">
                    <div class="style-field">
                        <label>标注字段</label>
                        <div class="style-control">
                            ${customSelectHTML('labelFieldSelect', fieldOpts, settings.field)}
                        </div>
                    </div>
                    <div class="style-field">
                        <label>${showLabel}</label>
                        <div class="style-control">
                            <label class="label-check">
                                <input type="checkbox" id="labelShowToggle" ${showChecked ? 'checked' : ''}/>
                            </label>
                        </div>
                    </div>
                </div>
            </div>
            <div class="style-group">
                <div class="style-group-title">文字</div>
                <div class="style-group-fields">
                    ${labelColorField('textColor', '文字颜色', settings.textColor)}
                    <div class="style-field">
                        <label>不透明度</label>
                        <div class="style-control">
                            <input type="range" id="labelTextOpacity" min="0" max="100" step="1" value="${textOpacityPct}" />
                            <span class="range-val" id="labelTextOpacityVal">${textOpacityPct}%</span>
                        </div>
                    </div>
                    <div class="style-field">
                        <label>字体</label>
                        <div class="style-control">
                            ${customSelectHTML('labelFontSelect', fontOpts, settings.fontFamily)}
                        </div>
                    </div>
                    <div class="style-field">
                        <label>字号</label>
                        <div class="style-control">
                            <input type="range" id="labelFontSize" min="9" max="28" step="1" value="${fontSize}" />
                            <span class="range-val" id="labelFontSizeVal">${fontSize}px</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="style-group">
                <div class="style-group-title">扫边（描边）</div>
                <div class="style-group-fields">
                    ${labelColorField('haloColor', '扫边颜色', settings.haloColor)}
                    <div class="style-field">
                        <label>不透明度</label>
                        <div class="style-control">
                            <input type="range" id="labelHaloOpacity" min="0" max="100" step="1" value="${haloOpacityPct}" />
                            <span class="range-val" id="labelHaloOpacityVal">${haloOpacityPct}%</span>
                        </div>
                    </div>
                    <div class="style-field">
                        <label>扫边宽度</label>
                        <div class="style-control">
                            <input type="range" id="labelHaloWidth" min="0" max="6" step="0.5" value="${haloWidth}" />
                            <span class="range-val" id="labelHaloWidthVal">${haloWidth}px</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    // R108：打开指定图层的 per-layer 标注设置
    function openLabelPanel(id) {
        const info = LayerManager.getLayerInfo(id);
        if (!info) return;
        labelPanelLayerId = id;
        // R114：标注默认文字色 = 该图层图例（主题）色
        const style = LayerManager.getLayerStyle(id);
        const gt = getGeometrySummary(info.data).type;
        labelLegendColor = LayerManager.getThemeColor(style, gt) || '#334155';
        const modal = document.getElementById('labelSettingsModal');
        const body = document.getElementById('labelSettingsBody');
        const title = document.getElementById('labelSettingsTitle');
        const sub = document.getElementById('labelSettingsSub');
        if (!modal || !body) return;
        if (title) title.textContent = info.config.name;
        if (sub) sub.textContent = '标注设置 · 仅对该图层生效';
        pendingLabel = Object.assign({}, LayerManager.getLayerLabelSettings(id));
        pendingLabel.show = info.labelsVisible;
        body.innerHTML = buildLabelSettingsForm(pendingLabel, { perLayer: true, layerId: id, show: info.labelsVisible });
        bindLabelSettingsInputs(body);
        modal.hidden = false;
        document.body.classList.add('modal-open');
    }

    function closeLabelSettings() {
        const modal = document.getElementById('labelSettingsModal');
        if (modal) modal.hidden = true;
        labelPanelLayerId = null;
        pendingLabel = null;
        document.body.classList.remove('modal-open');
    }

    function bindLabelSettingsInputs(body) {
        // R110：输入只写入 pendingLabel 并更新示例预览，点击「完成」才真正应用到地图
        // R114：自定义下拉绑定（替代原生 select 的 change 事件）
        bindCustomSelect(body, 'labelFieldSelect', function(val) { pendingLabel.field = val; });

        const showToggle = body.querySelector('#labelShowToggle');
        if (showToggle) showToggle.addEventListener('change', function() {
            pendingLabel.show = this.checked;
            updateLabelPreview(body);
        });

        // R111：标注颜色字段改用与图例一致的自定义取色器（点击 .color-field-btn 打开弹层）
        body.querySelectorAll('.color-field-btn[data-label-color]').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                // 再次点击同一按钮 = 收起取色器
                if (activeColorPicker && activeColorPicker.btn === this) { closeColorPicker(); return; }
                openColorPicker(this, null, { mode: 'label' });
            });
        });

        bindCustomSelect(body, 'labelFontSelect', function(val) {
            pendingLabel.fontFamily = val;
            updateLabelPreview(body);
        });

        const fontSize = body.querySelector('#labelFontSize');
        const fontSizeVal = body.querySelector('#labelFontSizeVal');
        if (fontSize) fontSize.addEventListener('input', function() {
            if (fontSizeVal) fontSizeVal.textContent = this.value + 'px';
            pendingLabel.fontSize = Number(this.value);
            updateLabelPreview(body);
        });

        const haloWidth = body.querySelector('#labelHaloWidth');
        const haloWidthVal = body.querySelector('#labelHaloWidthVal');
        if (haloWidth) haloWidth.addEventListener('input', function() {
            if (haloWidthVal) haloWidthVal.textContent = this.value + 'px';
            pendingLabel.haloWidth = Number(this.value);
            updateLabelPreview(body);
        });

        // R113：标注颜色不透明度（文字 / 扫边）
        const textOpacity = body.querySelector('#labelTextOpacity');
        const textOpacityVal = body.querySelector('#labelTextOpacityVal');
        if (textOpacity) textOpacity.addEventListener('input', function() {
            if (textOpacityVal) textOpacityVal.textContent = this.value + '%';
            pendingLabel.textOpacity = Number(this.value) / 100;
            updateLabelPreview(body);
        });
        const haloOpacity = body.querySelector('#labelHaloOpacity');
        const haloOpacityVal = body.querySelector('#labelHaloOpacityVal');
        if (haloOpacity) haloOpacity.addEventListener('input', function() {
            if (haloOpacityVal) haloOpacityVal.textContent = this.value + '%';
            pendingLabel.haloOpacity = Number(this.value) / 100;
            updateLabelPreview(body);
        });

        updateLabelPreview(body);
    }

    // R110：根据 pendingLabel 实时刷新标注示例预览（不直接改地图）
    function updateLabelPreview(body) {
        if (!pendingLabel || !body) return;
        const el = body.querySelector('[data-label-preview]');
        if (!el) return;
        const s = pendingLabel;
        el.style.fontFamily = s.fontFamily || '';
        const baseFont = (s.fontSize ? Number(s.fontSize) : 12);
        el.style.fontSize = baseFont + 'px';
        const textOpacity = (s.textOpacity === '' || s.textOpacity == null) ? 1 : Number(s.textOpacity);
        // R114：文字颜色空值 -> 图例色（与地图渲染一致），否则使用自定义色
        el.style.color = hexToRgba(s.textColor || labelLegendColor, textOpacity);
        const hw = (s.haloWidth === '' || s.haloWidth == null) ? 2 : Number(s.haloWidth);
        const haloOpacity = (s.haloOpacity === '' || s.haloOpacity == null) ? 1 : Number(s.haloOpacity);
        const hc = hexToRgba(s.haloColor || '#ffffff', haloOpacity);
        el.style.textShadow = hw > 0 ? `0 0 ${(hw * 1.5).toFixed(1)}px ${hc}, 0 0 ${(hw * 0.8).toFixed(1)}px ${hc}` : 'none';
        if (s.show === false) { el.style.opacity = '0.35'; el.title = '当前隐藏'; }
        else { el.style.opacity = ''; el.title = ''; }
    }

    // R114：自定义下拉交互绑定（打开/选择/点击外部关闭；选值存于 data-value）
    function bindCustomSelect(body, id, onSelect) {
        const el = body.querySelector('#' + id);
        if (!el) return;
        const trigger = el.querySelector('.custom-select-trigger');
        const optionsBox = el.querySelector('.custom-select-options');
        if (!trigger || !optionsBox) return;
        const close = () => { el.classList.remove('open'); optionsBox.style.display = 'none'; };
        trigger.addEventListener('click', function(e) {
            e.stopPropagation();
            const isOpen = el.classList.contains('open');
            // 同一面板内一次只展开一个下拉
            body.querySelectorAll('.custom-select.open').forEach(other => {
                if (other !== el) { other.classList.remove('open'); const ob = other.querySelector('.custom-select-options'); if (ob) ob.style.display = 'none'; }
            });
            if (isOpen) close();
            else { el.classList.add('open'); optionsBox.style.display = 'block'; }
        });
        optionsBox.querySelectorAll('.custom-select-option').forEach(opt => {
            opt.addEventListener('click', function(e) {
                e.stopPropagation();
                const val = opt.dataset.value;
                el.dataset.value = val;
                const valEl = el.querySelector('.custom-select-value');
                if (valEl) valEl.textContent = opt.textContent;
                optionsBox.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                close();
                if (onSelect) onSelect(val);
            });
        });
    }

    function initLabelSettings() {
        const modal = document.getElementById('labelSettingsModal');
        if (!modal) return;
        modal.addEventListener('click', function(e) { if (e.target === modal) closeLabelSettings(); });
        // R114：点击面板任意非下拉区域时收起已展开的下拉（仅绑定一次）
        if (!labelSelectOutsideBound) {
            labelSelectOutsideBound = true;
            document.addEventListener('click', function(e) {
                if (e.target.closest && e.target.closest('.custom-select')) return;
                document.querySelectorAll('.custom-select.open').forEach(sel => {
                    sel.classList.remove('open');
                    const ob = sel.querySelector('.custom-select-options');
                    if (ob) ob.style.display = 'none';
                });
            });
        }
        const closeBtn = document.getElementById('labelSettingsClose');
        if (closeBtn) closeBtn.addEventListener('click', closeLabelSettings);
        // R110：点击「完成」才将预览中的标注设置写入该图层
        const doneBtn = document.getElementById('labelSettingsDone');
        if (doneBtn) doneBtn.addEventListener('click', function() {
            // 面板只能由 openLabelPanel 打开，此时 labelPanelLayerId 必然已设置
            if (pendingLabel) {
                const id = labelPanelLayerId;
                LayerManager.setLayerLabelSettings(id, {
                    field: pendingLabel.field, textColor: pendingLabel.textColor,
                    haloColor: pendingLabel.haloColor, haloWidth: pendingLabel.haloWidth,
                    textOpacity: pendingLabel.textOpacity, haloOpacity: pendingLabel.haloOpacity,
                    fontFamily: pendingLabel.fontFamily, fontSize: pendingLabel.fontSize,
                });
                LayerManager.setLayerLabelsVisible(id, pendingLabel.show);
            }
            closeLabelSettings();
        });
        // R110：恢复默认只重置预览工作副本，不直接改地图（由「完成」提交）
        const resetBtn = document.getElementById('labelSettingsReset');
        if (resetBtn) resetBtn.addEventListener('click', function() {
            const body = document.getElementById('labelSettingsBody');
            const info = LayerManager.getLayerInfo(labelPanelLayerId);
            pendingLabel = Object.assign({}, LayerManager.getDefaultLabelSettings());
            pendingLabel.show = info ? info.labelsVisible : true;
            if (body) { body.innerHTML = buildLabelSettingsForm(pendingLabel, { perLayer: true, layerId: labelPanelLayerId, show: pendingLabel.show }); bindLabelSettingsInputs(body); }
        });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && !modal.hidden) closeLabelSettings();
        });
    }

    // ---------- 统一应用弹窗（确认 / 信息共用） ----------
    // 返回 Promise：confirmText → true；cancelText / 遮罩 / Esc → false。
    // 不传 cancelText 时为「信息模式」（只有确认按钮）。
    // `nowrap: true` 弹窗消息不换行（弹窗宽度按内容自适应），用于短确认（如下载）
    function showAppModal({ icon = 'fa-circle-question', title = '提示', message = '', confirmText = '确认', cancelText = '取消', danger = false, nowrap = false } = {}) {
        const overlay = document.getElementById('appModal');
        if (!overlay) return Promise.resolve(false);
        const card = overlay.querySelector('.app-modal');
        const titleEl = overlay.querySelector('#appModalTitle');
        const iconEl = overlay.querySelector('.app-modal-icon i');
        const body = overlay.querySelector('#appModalMessage');
        const cancelBtn = overlay.querySelector('#appModalCancel');
        const confirmBtn = overlay.querySelector('#appModalConfirm');
        if (!titleEl || !body || !cancelBtn || !confirmBtn) return Promise.resolve(false);

        titleEl.textContent = title;
        if (iconEl) {
            iconEl.className = `fas ${icon}`;
            iconEl.classList.toggle('danger', danger);
        }
        // textContent 避免内容被当作 HTML 解析
        body.textContent = message;
        confirmBtn.textContent = confirmText;
        confirmBtn.classList.toggle('danger', danger);
        cancelBtn.textContent = cancelText || '';
        cancelBtn.hidden = !cancelText;
        // nowrap 时弹窗宽度按内容自适应（一行显示，不折行）
        if (card) card.classList.toggle('nowrap', nowrap);

        // 打开弹窗前关闭所有其它浮层（分组更多 / 底图 / 搜索），
        // 避免它们与弹窗重叠显示
        closeAllGroupMoreMenus();
        closeAllMapToolMenus();

        overlay.hidden = false;
        document.body.classList.add('modal-open');

        return new Promise(resolve => {
            const cleanup = () => {
                overlay.hidden = true;
                document.body.classList.remove('modal-open');
                if (card) card.classList.remove('nowrap');
                cancelBtn.removeEventListener('click', onCancel);
                confirmBtn.removeEventListener('click', onConfirm);
                overlay.removeEventListener('click', onOverlay);
                document.removeEventListener('keydown', onKey);
            };
            const onCancel = () => { cleanup(); resolve(false); };
            const onConfirm = () => { cleanup(); resolve(true); };
            const onOverlay = (e) => { if (e.target === overlay) { cleanup(); resolve(false); } };
            const onKey = (e) => { if (e.key === 'Escape') { cleanup(); resolve(false); } };
            cancelBtn.addEventListener('click', onCancel);
            confirmBtn.addEventListener('click', onConfirm);
            overlay.addEventListener('click', onOverlay);
            document.addEventListener('keydown', onKey);
            confirmBtn.focus();
        });
    }

    // ---------- 复制到剪贴板（R59：邮箱点击复制，替代依赖邮件客户端的 mailto） ----------
    // 优先 Clipboard API（localhost/https secure context 可用），失败回退 execCommand
    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
                () => showToast(`已复制：${text}`, 'success'),
                () => fallbackCopy(text)
            );
        } else {
            fallbackCopy(text);
        }
    }

    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { /* 忽略 */ }
        document.body.removeChild(ta);
        showToast(ok ? `已复制：${text}` : '复制失败，请手动复制', ok ? 'success' : 'error');
    }

    // ---------- 作者信息弹窗（导航栏「关于作者」头像按钮打开） ----------
    // 内容来自 CONFIG.author，纯 textContent 渲染防注入；关闭：关闭按钮 / 知道了 / 遮罩 / Esc
    function showAuthorModal() {
        const overlay = document.getElementById('authorModal');
        if (!overlay) return;
        const author = (typeof CONFIG !== 'undefined' && CONFIG.author) || {};
        const nameEl = overlay.querySelector('#authorModalName');
        const avatarEl = overlay.querySelector('#authorAvatar');
        const taglineEl = overlay.querySelector('#authorModalTagline');
        const bioEl = overlay.querySelector('#authorModalBio');
        const websiteEl = overlay.querySelector('#authorModalWebsite');
        const detailsEl = overlay.querySelector('#authorModalDetails');
        if (nameEl) nameEl.textContent = author.name || '佚名';
        if (avatarEl) avatarEl.textContent = String(author.name || '?').trim().charAt(0);
        if (taglineEl) taglineEl.textContent = author.tagline || '';
        if (bioEl) bioEl.textContent = author.bio || '';
        if (websiteEl) websiteEl.textContent = author.website || '';
        if (detailsEl) {
            detailsEl.innerHTML = '';
            (author.details || []).forEach(detail => {
                const li = document.createElement('li');
                const icon = document.createElement('span');
                icon.className = 'detail-icon';
                const i = document.createElement('i');
                i.className = `fas ${detail.icon || 'fa-circle-info'}`;
                icon.appendChild(i);
                const text = document.createElement('span');
                text.className = 'detail-text';
                const label = document.createElement('span');
                label.className = 'detail-label';
                label.textContent = detail.label || '';
                const value = document.createElement('span');
                value.className = 'detail-value';
                value.textContent = detail.value || '';
                text.appendChild(label);
                text.appendChild(value);
                li.appendChild(icon);
                li.appendChild(text);
                detailsEl.appendChild(li);
            });
        }
        // 联系方式（R68 起按归属分列）：邮箱属作者 → 左列容器；GitHub 属项目 → 右列容器。
        // 邮箱点击复制到剪贴板（mailto 依赖邮件客户端不可靠）；外链新窗口。文本一律 textContent 防注入
        const contactAuthorEl = overlay.querySelector('#authorModalContactAuthor');
        const contactProjectEl = overlay.querySelector('#authorModalContactProject');
        // R72：每次打开必须先清空容器——R68 分流渲染后丢失了 innerHTML='' 清空，
        // 导致重复打开弹窗时邮箱/GitHub 累积 append、出现多次
        if (contactAuthorEl) contactAuthorEl.innerHTML = '';
        if (contactProjectEl) contactProjectEl.innerHTML = '';
        (author.contacts || []).forEach(contact => {
            const target = contact.side === 'project' ? contactProjectEl : contactAuthorEl;
            if (!target) return;
            const el = document.createElement(contact.action === 'copy' ? 'button' : 'a');
            if (contact.action === 'copy') el.type = 'button';
            el.className = 'contact-item' + (contact.action === 'copy' ? ' contact-copy' : '');
            if (contact.action === 'copy') {
                el.dataset.tooltip = '点击复制邮箱';
                el.setAttribute('aria-label', '复制邮箱地址');
                el.addEventListener('click', () => copyToClipboard(contact.value));
            } else {
                el.href = contact.href || '#';
                if (contact.href && contact.href.startsWith('http')) {
                    el.target = '_blank';
                    el.rel = 'noopener noreferrer';
                }
            }
            const icon = document.createElement('span');
            icon.className = 'detail-icon';
            const i = document.createElement('i');
            i.className = contact.icon || 'fas fa-circle-info';
            icon.appendChild(i);
            const text = document.createElement('span');
            text.className = 'contact-text';
            const label = document.createElement('span');
            label.className = 'contact-label';
            label.textContent = contact.label || '';
            const value = document.createElement('span');
            value.className = 'contact-value';
            value.textContent = contact.value || '';
            text.appendChild(label);
            text.appendChild(value);
            if (contact.desc) {
                const desc = document.createElement('span');
                desc.className = 'contact-desc';
                desc.textContent = contact.desc;
                text.appendChild(desc);
            }
            el.appendChild(icon);
            el.appendChild(text);
            target.appendChild(el);
        });

        overlay.hidden = false;
        document.body.classList.add('modal-open');
        const closeBtn = overlay.querySelector('#authorModalClose');
        const okBtn = overlay.querySelector('#authorModalOk');
        const cleanup = () => {
            overlay.hidden = true;
            document.body.classList.remove('modal-open');
            if (closeBtn) closeBtn.removeEventListener('click', onClose);
            if (okBtn) okBtn.removeEventListener('click', onClose);
            overlay.removeEventListener('click', onOverlay);
            document.removeEventListener('keydown', onKey);
        };
        const onClose = () => cleanup();
        const onOverlay = (e) => { if (e.target === overlay) cleanup(); };
        const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
        if (closeBtn) closeBtn.addEventListener('click', onClose);
        if (okBtn) okBtn.addEventListener('click', onClose);
        overlay.addEventListener('click', onOverlay);
        document.addEventListener('keydown', onKey);
        if (okBtn) okBtn.focus();
    }

    function showToast(message, type = 'info', duration = 3000) {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        // R88：提示消息出现在面板（侧边栏）右侧而非屏幕最右
        const sidebar = document.getElementById('sidebar');
        const sidebarOpen = sidebar && !sidebar.classList.contains('sidebar--collapsed');
        if (sidebarOpen) {
            const sbWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || 320;
            container.style.left = (sbWidth + 12) + 'px';
        } else {
            container.style.left = '12px';
        }
        container.style.right = 'auto';

        const icons = {
            success: 'fas fa-check-circle',
            error: 'fas fa-exclamation-circle',
            info: 'fas fa-info-circle',
            warning: 'fas fa-exclamation-triangle'
        };

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        const icon = document.createElement('i');
        icon.className = icons[type] || icons.info;
        const text = document.createElement('span');
        // textContent 避免消息内容被当作 HTML 解析
        text.textContent = message;
        toast.appendChild(icon);
        toast.appendChild(text);

        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    return {
        init,
        updateLayerPanel,
        updateLayerItem,
        syncDatasetHiddenStates,
        updateLegend,
        updateButtonsState,
        addDatasets,
        toggleTheme,
        toggleFullscreen,
        togglePanel,
        showToast,
        showAuthorModal,
    };
})();