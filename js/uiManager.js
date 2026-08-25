/**
 * UI管理器 - 现代化图层切换
 */

const UIManager = (function() {
    let isDark = false;
    let isFullscreen = false;
    let sortableInstances = [];
    let searchKeyword = '';
    let stylePanelLayerId = null;
    // 数据集菜单元素（portal 到 body 后 wrap.querySelector 找不到，须闭包持有引用）
    let datasetMenuEl = null;

    // 已折叠的数据集分组（localStorage 持久化）
    const COLLAPSE_STORAGE_KEY = 'lyc_collapsed_groups_v1';
    const collapsedGroups = new Set(readCollapsedGroups());

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

    const BUTTON_IDS = [
        'selectAll', 'deselectAll',
        'zoomToAll'
    ];

    function init() {
        bindEvents();
        initSortable();
        initTooltips();
        document.addEventListener('fullscreenchange', syncFullscreenState);

        const savedTheme = localStorage.getItem('mapTheme');
        if (savedTheme === 'dark') {
            toggleTheme();
        }

        updateButtonsState(false);
        applyPanelButtonState();
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
    // 添加数据集菜单：多选数据集，一键批量加载到图层列表
    // ================================================================

    function updateAddDatasetMenu() {
        const wrap = document.getElementById('datasetAdd');
        if (!wrap) return;
        const menu = datasetMenuEl || wrap.querySelector('.dataset-select-menu');
        if (!menu) return;

        const datasets = DataScanner.getDatasets();
        const loadedGroups = new Set(LayerManager.getLoadedGroupNames());

        if (datasets.length === 0) {
            menu.innerHTML = '<div class="dataset-menu-empty"><i class="fas fa-database"></i>暂无可用数据集</div>';
            return;
        }

        // 已加载项：checkbox 默认勾选、可取消（取消 = 从地图移除）；未加载项：勾选 = 添加。
        // 徽章：已加载 →「已加载」；取消勾选 →「待移除」；未加载勾选 →「待添加」
        const options = datasets.map(dataset => {
            const loaded = loadedGroups.has(dataset.name);
            const safeName = escapeHtml(dataset.name);
            return `<label class="dataset-select-option${loaded ? ' loaded' : ''}" data-value="${safeName}">
                <input type="checkbox" ${loaded ? 'checked' : ''} />
                <span class="dataset-option-name">${safeName}<em>${dataset.sources.length} 个图层</em></span>
                <span class="dataset-option-badge" data-badge>${loaded ? '已加载' : ''}</span>
            </label>`;
        }).join('');

        menu.innerHTML = `
            <div class="dataset-menu-head">
                <div class="dataset-menu-title">管理数据集</div>
                <div class="dataset-menu-desc">勾选 = 添加到地图；取消已加载项的勾选 = 从地图移除</div>
            </div>
            <div class="dataset-menu-body">${options}</div>
            <div class="dataset-menu-footer">
                <span class="dataset-menu-count">未改动</span>
                <div class="dataset-menu-actions">
                    <button type="button" class="dataset-cancel-btn">取消</button>
                    <button type="button" class="dataset-apply-btn" disabled>应用</button>
                </div>
            </div>
        `;

        // 选项点击：label 默认行为自动 toggle checkbox，change 事件同步勾选态、徽章与底部计数；
        // 注意：不要再手动改 input.checked——label 会再派发一次 click 导致双重 toggle
        menu.querySelectorAll('.dataset-select-option').forEach(option => {
            const input = option.querySelector('input');
            if (input) {
                input.addEventListener('change', () => {
                    option.classList.toggle('selected', input.checked);
                    updateOptionBadge(option, input.checked);
                    updateDatasetMenuState(menu);
                });
            }
        });

        // 取消：关闭菜单
        menu.querySelector('.dataset-cancel-btn').addEventListener('click', () => {
            closeAddDatasetMenu(wrap);
        });

        // 应用：添加勾选的未加载数据集 + 移除取消勾选的已加载数据集
        menu.querySelector('.dataset-apply-btn').addEventListener('click', async () => {
            const toAdd = [...menu.querySelectorAll('.dataset-select-option:not(.loaded)')]
                .filter(option => option.querySelector('input').checked)
                .map(option => option.dataset.value);
            const toRemove = [...menu.querySelectorAll('.dataset-select-option.loaded')]
                .filter(option => !option.querySelector('input').checked)
                .map(option => option.dataset.value);
            if (toAdd.length === 0 && toRemove.length === 0) return;
            if (toRemove.length > 0) {
                const ok = await showAppModal({
                    icon: 'fa-trash-can',
                    title: '移除数据集',
                    message: `将从地图移除：${toRemove.join('、')}\n其图层将从地图与列表中移除，可随时重新添加。`,
                    confirmText: '移除',
                    danger: true,
                });
                if (!ok) return;
            }
            closeAddDatasetMenu(wrap);
            if (toAdd.length > 0) await addDatasets(toAdd);
            toRemove.forEach(name => LayerManager.removeDataset(name));
            if (toRemove.length > 0) showToast(`已移除 ${toRemove.length} 个数据集`, 'info');
        });
    }

    // 选项徽章状态：未加载勾选 →「待添加」；已加载取消勾选 →「待移除」；其余恢复默认
    function updateOptionBadge(option, checked) {
        const badge = option.querySelector('[data-badge]');
        if (!badge) return;
        const loaded = option.classList.contains('loaded');
        if (!loaded && checked) {
            badge.textContent = '待添加';
            badge.classList.add('pending-add');
            badge.classList.remove('pending-remove');
            badge.hidden = false;
        } else if (loaded && !checked) {
            badge.textContent = '待移除';
            badge.classList.add('pending-remove');
            badge.classList.remove('pending-add');
            badge.hidden = false;
        } else {
            badge.textContent = loaded ? '已加载' : '';
            badge.classList.remove('pending-add', 'pending-remove');
            badge.hidden = loaded ? false : true;
        }
    }

    // 菜单底部：添加/移除计数 + 「应用」按钮可用态
    function updateDatasetMenuState(menu) {
        const addCount = [...menu.querySelectorAll('.dataset-select-option:not(.loaded)')]
            .filter(option => option.querySelector('input').checked).length;
        const removeCount = [...menu.querySelectorAll('.dataset-select-option.loaded')]
            .filter(option => !option.querySelector('input').checked).length;
        const count = menu.querySelector('.dataset-menu-count');
        const apply = menu.querySelector('.dataset-apply-btn');
        if (count) {
            if (addCount === 0 && removeCount === 0) count.textContent = '未改动';
            else if (removeCount === 0) count.textContent = `添加 ${addCount} 个`;
            else if (addCount === 0) count.textContent = `移除 ${removeCount} 个`;
            else count.textContent = `添加 ${addCount} 个 · 移除 ${removeCount} 个`;
        }
        if (apply) apply.disabled = addCount === 0 && removeCount === 0;
    }

    function closeAddDatasetMenu(wrap) {
        wrap.classList.remove('open');
        const menu = datasetMenuEl || wrap.querySelector('.dataset-select-menu');
        if (menu) {
            menu.classList.remove('open');
            // 菜单移回 wrap：面板重建/下次打开时始终能按 wrap 内查找
            if (menu.parentElement !== wrap) wrap.appendChild(menu);
        }
        wrap.querySelector('.dataset-add-btn')?.setAttribute('aria-expanded', 'false');
    }

    // 数据集菜单定位（fixed，菜单已在 body）：右对齐按钮下方，视口内 clamp；
    // 底部空间不足时压缩菜单高度（内部 body 滚动）
    function positionDatasetMenu(menu) {
        const wrap = document.getElementById('datasetAdd');
        if (!wrap || !menu) return;
        const btn = wrap.querySelector('.dataset-add-btn');
        if (!btn) return;
        const rect = btn.getBoundingClientRect();
        const mw = menu.offsetWidth || 292;
        let left = rect.right - mw;
        left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
        let top = rect.bottom + 8;
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
        // 底部放不下时优先压缩菜单自身高度（body 区内部滚动），压到极限仍不够再向上翻
        const avail = window.innerHeight - top - 8;
        if (avail < 160) {
            menu.style.maxHeight = '';
            const mh = menu.offsetHeight;
            top = Math.max(8, rect.top - mh - 8);
            menu.style.top = `${Math.round(top)}px`;
            menu.style.maxHeight = `${Math.min(mh, window.innerHeight - top - 8)}px`;
        } else {
            menu.style.maxHeight = `${Math.round(avail)}px`;
        }
    }

    // 批量加载数据集：依次加载，汇总成功/失败；全部加载后缩放到整体范围
    async function addDatasets(names) {
        if (!names || names.length === 0) return;
        const bounds = L.latLngBounds();
        let hasValid = false;
        let loaded = 0;
        const failedNames = [];
        for (const name of names) {
            const result = await LayerManager.loadDataset(name);
            if (result.loaded > 0) {
                loaded += 1;
                LayerManager.getLayersByGroup(name).forEach(info => {
                    if (info.visible && info.layer.getBounds().isValid()) {
                        bounds.extend(info.layer.getBounds());
                        hasValid = true;
                    }
                });
            }
            if (result.failed > 0) failedNames.push(name);
        }
        if (hasValid) MapManager.fitBounds(bounds);
        if (loaded > 0) showToast(`已加载 ${loaded} 个数据集`, 'success');
        if (failedNames.length > 0) showToast(`${failedNames.join('、')} 部分图层加载失败`, 'warning');
    }

    function initTooltips() {
        let tooltip = null;
        let activeElement = null;

        const hideTooltip = function() {
            if (tooltip) tooltip.remove();
            tooltip = null;
            activeElement = null;
        };

        const showTooltip = function(element) {
            const text = element.dataset.tooltip;
            if (!text) return;
            hideTooltip();
            activeElement = element;
            tooltip = document.createElement('div');
            tooltip.className = 'app-tooltip';
            tooltip.textContent = text;
            document.body.appendChild(tooltip);

            const rect = element.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            const gap = 8;
            let left = rect.left + (rect.width - tooltipRect.width) / 2;
            let top = rect.top - tooltipRect.height - gap;

            if (top < 8) top = rect.bottom + gap;
            left = Math.max(8, Math.min(left, window.innerWidth - tooltipRect.width - 8));
            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        };

        document.addEventListener('pointerover', event => {
            const element = event.target.closest?.('[data-tooltip]');
            if (element) showTooltip(element);
        });
        document.addEventListener('pointerout', event => {
            if (activeElement && !activeElement.contains(event.relatedTarget)) hideTooltip();
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
        container.querySelectorAll('.layer-group-items').forEach(groupContainer => {
            sortableInstances.push(Sortable.create(groupContainer, {
                handle: '.drag-handle',
                animation: 200,
                easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                ghostClass: 'sortable-ghost',
                chosenClass: 'sortable-chosen',
                dragClass: 'sortable-drag',
                forceFallback: true,
                fallbackOnBody: true,
                fallbackTolerance: 2,
                // 拖拽期间容器加 sorting-active：图层行 transition 全部归零，
                // 避免 .layer-item 的 transition: all 与 Sortable 让位动画叠加造成卡顿（流畅度核心）
                onStart: () => container.classList.add('sorting-active'),
                onEnd: function() {
                    container.classList.remove('sorting-active');
                    LayerManager.setLayerOrder(collectLayerOrder(container));
                }
            }));
        });

        // 分组级 Sortable：整个数据集分组可拖拽调整加载顺序（handle 限分组头把手）。
        // 分组顺序 = 图层顺序的子集（同一分组图层连续）——拖完后按新 DOM 顺序重排图层即可，
        // setLayerOrder 会同时重设 z-order 并持久化到 lyc_layer_order_v1（刷新后分组顺序随之恢复）
        sortableInstances.push(Sortable.create(container, {
            handle: '.layer-group-drag',
            animation: 200,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            ghostClass: 'sortable-ghost',
            chosenClass: 'sortable-chosen',
            dragClass: 'sortable-drag',
            forceFallback: true,
            fallbackOnBody: true,
            fallbackTolerance: 2,
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
            const currentLayers = [...getCurrentLayers().values()];
            const hasVisibleLayer = currentLayers.some(info => info.visible);
            const hasHiddenLayer = currentLayers.some(info => !info.visible);
            zoomToAll.disabled = !enabled || !hasVisibleLayer;
            const selectAll = document.getElementById('selectAll');
            const deselectAll = document.getElementById('deselectAll');
            if (selectAll) selectAll.disabled = !enabled || !hasHiddenLayer;
            if (deselectAll) deselectAll.disabled = !enabled || !hasVisibleLayer;
        }

        // 展开/折叠所有分组按钮：可用态只取决于分组折叠情况，统一交给 updateGroupButtonsState；
        // 分组头 显示/隐藏/缩放 按钮可用态随图层可见性变化同步
        updateGroupButtonsState();
        syncGroupVisButtons();
    }

    // 同步所有分组头 显示/隐藏/缩放 按钮可用态（批量显隐/单图层切换后由 updateButtonsState 调用）
    function syncGroupVisButtons() {
        document.querySelectorAll('#layerList .layer-group').forEach(groupEl => {
            updateGroupVisButtons(groupEl, groupEl.dataset.group);
        });
    }

    function bindEvents() {
        // 点击任何位置关闭分组头「更多」菜单（菜单项与更多按钮均已 stopPropagation）
        document.addEventListener('click', closeAllGroupMoreMenus);
        // 任何容器滚动时让「更多」菜单跟随按钮重新定位（scroll 不冒泡，捕获阶段可监听所有元素）
        document.addEventListener('scroll', repositionGroupMoreMenus, true);

        const datasetAdd = document.getElementById('datasetAdd');
        if (datasetAdd) {
            datasetMenuEl = datasetAdd.querySelector('.dataset-select-menu');
            datasetAdd.querySelector('.dataset-add-btn').addEventListener('click', function(event) {
                event.stopPropagation();
                const menu = datasetMenuEl;
                if (!menu) return;
                const wasOpen = menu.classList.contains('open');
                closeAddDatasetMenu(datasetAdd);
                if (wasOpen) return; // toggle：再次点击关闭
                // portal：菜单移入 body，避免面板 backdrop-filter 劫持 fixed 定位基准 / max-height 裁剪
                if (menu.parentElement !== document.body) {
                    document.body.appendChild(menu);
                }
                // 每次打开重渲染菜单，重置勾选状态（已加载项仍显示已加载）
                updateAddDatasetMenu();
                menu.classList.add('open');
                datasetAdd.classList.add('open');
                this.setAttribute('aria-expanded', 'true');
                positionDatasetMenu(menu);
            });
            document.addEventListener('click', event => {
                const menu = datasetMenuEl;
                if (!datasetAdd.contains(event.target) && !(menu && menu.contains(event.target))) {
                    closeAddDatasetMenu(datasetAdd);
                }
            });
        }
        // 「关于作者」按钮（导航栏右侧，独立入口）：打开作者信息弹窗（R56）
        const aboutAuthor = document.getElementById('aboutAuthor');
        if (aboutAuthor) {
            aboutAuthor.addEventListener('click', showAuthorModal);
        }

        const themeBtn = document.getElementById('toggleTheme');
        if (themeBtn) {
            themeBtn.addEventListener('click', toggleTheme);
        }

        const fullscreenBtn = document.getElementById('toggleFullscreen');
        if (fullscreenBtn) {
            fullscreenBtn.addEventListener('click', toggleFullscreen);
        }

        const panelBtn = document.getElementById('togglePanel');
        if (panelBtn) {
            panelBtn.addEventListener('click', togglePanel);
        }

        const collapseBtn = document.getElementById('panelCollapse');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', togglePanel);
        }

        const searchInput = document.getElementById('layerSearch');
        const searchClear = document.getElementById('searchClear');

        if (searchInput) {
            searchInput.addEventListener('input', function(e) {
                searchKeyword = e.target.value.trim();
                applySearchFilter();
                if (searchClear) {
                    searchClear.style.display = searchKeyword ? 'block' : 'none';
                }
            });
        }

        if (searchClear) {
            searchClear.addEventListener('click', function() {
                if (searchInput) {
                    searchInput.value = '';
                    searchInput.dispatchEvent(new Event('input'));
                    searchInput.focus();
                }
            });
        }

        const selectAllBtn = document.getElementById('selectAll');
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', function() {
                const allLayers = getCurrentLayers();
                if (allLayers.size === 0) {
                    showToast('暂无图层数据', 'info');
                    return;
                }
                const changed = [...allLayers.values()].some(info => !info.visible);
                LayerManager.setAllVisibility(true, allLayers);
                showToast(changed ? '✅ 已全部显示' : '所有图层已显示', changed ? 'success' : 'info');
            });
        }

        const deselectAllBtn = document.getElementById('deselectAll');
        if (deselectAllBtn) {
            deselectAllBtn.addEventListener('click', function() {
                const allLayers = getCurrentLayers();
                if (allLayers.size === 0) {
                    showToast('暂无图层数据', 'info');
                    return;
                }
                const changed = [...allLayers.values()].some(info => info.visible);
                LayerManager.setAllVisibility(false, allLayers);
                showToast(changed ? '⬜ 已全部隐藏' : '所有图层已隐藏', changed ? 'success' : 'info');
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
                    if (info.visible && info.layer.getBounds().isValid()) {
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
            if (doneBtn) doneBtn.addEventListener('click', closeStylePanel);
            const resetBtn = document.getElementById('styleReset');
            if (resetBtn) {
                resetBtn.addEventListener('click', function() {
                    if (!stylePanelLayerId) return;
                    LayerManager.resetLayerStyle(stylePanelLayerId);
                    refreshStylePanel();
                    this.disabled = true;
                    showToast('已恢复默认样式', 'info');
                });
            }
            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape' && !styleModal.hidden) closeStylePanel();
            });
        }
    }

    // ================================================================
    // updateLayerPanel - 去掉状态文字和删除按钮
    // ================================================================

    // hex → rgba（用于图例还原颜色透明度）
    function hexToRgba(hex, alpha) {
        const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!match) return hex;
        const int = parseInt(match[1], 16);
        const r = (int >> 16) & 255, g = (int >> 8) & 255, b = int & 255;
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    // 透明度钳制到 0~1（非法值按 1 处理）
    function clamp01(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return 1;
        return Math.min(1, Math.max(0, num));
    }

    // 按当前样式生成图层图例（与地图显示严格对应：点大小/边线宽、线宽、填充/描边/边线透明度）
    // 注意：不加投影阴影——阴影会让细线/小点看起来比地图实际渲染的更大
    function legendSwatchHTML(style, type) {
        if (!style) return '';
        const pointColor = hexToRgba(style.pointColor || '#4f6ef7', clamp01(style.pointOpacity ?? 1));
        const pointStroke = hexToRgba(style.pointStrokeColor || '#ffffff', clamp01(style.pointStrokeOpacity ?? 1));
        const pointStrokeW = Math.max(0, Number(style.pointStrokeWidth) || 0);
        const pointSize = Math.max(4, Number(style.pointSize) || 10);
        const lineColor = hexToRgba(style.lineColor || '#4f6ef7', clamp01(style.lineOpacity ?? 0.9));
        const lineWidth = Math.max(0.5, Number(style.lineWidth) || 2.5);
        const fillColor = style.fillColor || '#4f6ef7';
        const fillOpacity = clamp01(style.fillOpacity ?? 0.35);
        const strokeColor = hexToRgba(style.strokeColor || fillColor, clamp01(style.strokeOpacity ?? 0.95));
        const strokeWidth = Math.max(0, Number(style.strokeWidth) || 0);
        if (type === 'point') {
            // 总尺寸 = 点内径 + 两侧边线；描边用 box-shadow inset 实现——CSS border 宽度会被浏览器
            // 取整（1.5px 实际渲染 1px），而 box-shadow 支持亚像素，与地图 SVG 图标精确一致
            const total = pointSize + pointStrokeW * 2;
            return `<span class="swatch swatch--point" style="width:${total}px;height:${total}px;background:${escapeHtml(pointColor)};box-shadow:inset 0 0 0 ${pointStrokeW}px ${escapeHtml(pointStroke)};"></span>`;
        }
        if (type === 'line') {
            // 厚度 = 真实线宽；长度随线宽等比放大（粗线不再是固定短条），上限受容器宽度约束
            const lineLen = Math.round(Math.min(40, Math.max(22, lineWidth * 5)));
            return `<span class="swatch swatch--line" style="width:${lineLen}px;height:${lineWidth}px;background:${escapeHtml(lineColor)};"></span>`;
        }
        if (type === 'polygon') {
            // 描边用 box-shadow inset（亚像素精确）；border 宽度会被浏览器取整导致与地图描边偏差
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

        return `
            <div class="layer-item ${isVisible ? '' : 'hidden'}${highlighted ? ' highlighted' : ''}" data-id="${safeId}">
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
                        <span class="meta-count"><i class="fas ${geometry.icon}"></i> ${featureCount} 个要素</span>
                    </div>
                </div>
                <div class="layer-actions">
                    <button type="button" class="zoom-btn" data-tooltip="${isVisible ? '缩放至该图层' : '图层隐藏时不可缩放'}" aria-label="缩放至${safeName}" ${isVisible ? '' : 'disabled'}>
                        <i class="fas fa-crosshairs"></i>
                    </button>
                    <button type="button" class="download-btn" data-tooltip="下载该图层数据" aria-label="下载${safeName}数据">
                        <i class="fas fa-download"></i>
                    </button>
                    <button type="button" class="label-btn ${labelsVisible ? 'active' : ''}" data-tooltip="${!isVisible ? '图层隐藏时不可显示标注' : (labelField ? (labelsVisible ? '隐藏标注' : '显示标注') : '无可用标注字段，无法标注')}" aria-label="${labelField ? (labelsVisible ? '隐藏' + safeName + '标注' : '显示' + safeName + '标注') : safeName + '无法标注'}" ${labelsEnabled ? '' : 'disabled'}>
                        <i class="fas fa-tag"></i>
                    </button>
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

        item.classList.toggle('hidden', !isVisible);
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

        // 下载按钮：数据下载与图层可见性无关，始终可用
        const downloadBtn = item.querySelector('.download-btn');
        if (downloadBtn) {
            downloadBtn.dataset.tooltip = `下载「${info.config.name}」数据`;
        }

        const labelBtn = item.querySelector('.label-btn');
        if (labelBtn) {
            labelBtn.disabled = !labelsEnabled;
            labelBtn.classList.toggle('active', isVisible && info.labelsVisible);
            labelBtn.dataset.tooltip = !isVisible ? '图层隐藏时不可显示标注'
                : (info.labelField ? (info.labelsVisible ? '隐藏标注' : '显示标注') : '无可用标注字段，无法标注');
        }
    }

    // 应用搜索过滤：分组感知 + 搜索时强制展开折叠分组 + 无结果提示
    function applySearchFilter() {
        const container = document.getElementById('layerList');
        if (!container) return;
        container.classList.toggle('searching', !!searchKeyword);
        const matched = LayerManager.filterLayers(searchKeyword);

        let note = container.querySelector('.filter-empty');
        if (searchKeyword && matched === 0) {
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

    // 分组头操作按钮可用态：全可见时禁用显示、全隐藏时禁用隐藏/缩放。
    // 注意：更多菜单项可能已 portal 到 body，不能只查 groupEl 内
    function updateGroupVisButtons(groupEl, name) {
        const infos = [...LayerManager.getLayersByGroup(name).values()];
        if (infos.length === 0) return;
        const allVisible = infos.every(info => info.visible);
        const noneVisible = infos.every(info => !info.visible);
        const esc = CSS.escape(name);
        const findIn = (cls) =>
            document.querySelector(`body > .layer-group-more-menu[data-group="${esc}"] .${cls}`)
            || groupEl.querySelector(`.${cls}`);
        const showBtn = findIn('layer-group-show');
        const hideBtn = findIn('layer-group-hide');
        const zoomBtn = groupEl.querySelector('.layer-group-zoom');
        if (showBtn) showBtn.disabled = allVisible;
        if (hideBtn) hideBtn.disabled = noneVisible;
        if (zoomBtn) zoomBtn.disabled = noneVisible;
    }

    // 缩放到指定数据集内全部可见图层的范围
    function zoomToDataset(name) {
        const bounds = L.latLngBounds();
        let hasValid = false;
        LayerManager.getLayersByGroup(name).forEach(info => {
            if (info.visible && info.layer.getBounds().isValid()) {
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
                const wrap = document.querySelector(`.layer-group[data-group="${CSS.escape(groupName)}"] .layer-group-more`);
                const btn = wrap?.querySelector('.layer-group-more-btn');
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
            const btn = document.querySelector(`.layer-group[data-group="${CSS.escape(groupName)}"] .layer-group-more-btn`);
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

        updateAddDatasetMenu();
        const allLayers = getCurrentLayers();

        const hasData = allLayers.size > 0;
        updateButtonsState(hasData);

        if (allLayers.size === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-database empty-icon"></i>
                    <div class="empty-title">尚未添加数据集</div>
                    <div class="empty-desc">点击上方「添加数据集」把数据加载到地图</div>
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
                                <button type="button" class="more-item layer-group-show" role="menuitem" data-tooltip="显示全部图层" aria-label="显示${safeName}全部图层">
                                    <i class="fas fa-eye"></i><span>显示全部</span>
                                </button>
                                <button type="button" class="more-item layer-group-hide" role="menuitem" data-tooltip="隐藏全部图层" aria-label="隐藏${safeName}全部图层">
                                    <i class="fas fa-eye-slash"></i><span>隐藏全部</span>
                                </button>
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
        document.querySelectorAll('.layer-group-more-menu').forEach(menu => {
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

            // 菜单项：数据集介绍 / 显示全部 / 隐藏全部 / 删除数据集
            groupEl.querySelector('.layer-group-info')?.addEventListener('click', function(e) {
                e.stopPropagation();
                closeAllGroupMoreMenus();
                const dataset = DataScanner.getDataset(name);
                const info = dataset && dataset.info ? dataset.info : '暂无介绍';
                showAppModal({ icon: 'fa-circle-info', title: name, message: info, confirmText: '知道了', cancelText: '' });
            });
            groupEl.querySelector('.layer-group-show')?.addEventListener('click', function(e) {
                e.stopPropagation();
                if (this.disabled) return;
                closeAllGroupMoreMenus();
                LayerManager.setAllVisibility(true, LayerManager.getLayersByGroup(name));
                updateGroupVisButtons(groupEl, name);
                showToast(`已显示「${name}」全部图层`, 'success');
            });
            groupEl.querySelector('.layer-group-hide')?.addEventListener('click', function(e) {
                e.stopPropagation();
                if (this.disabled) return;
                closeAllGroupMoreMenus();
                LayerManager.setAllVisibility(false, LayerManager.getLayersByGroup(name));
                updateGroupVisButtons(groupEl, name);
                showToast(`已隐藏「${name}」全部图层`, 'info');
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

    // 绑定单个图层行的事件（显隐开关 / 图例开样式 / 图层名高亮 / 双击缩放 / 标注）
    function bindLayerItem(item, id) {
        // 单击图例图标：打开该图层样式设置（图层隐藏时不可用）
        const swatch = item.querySelector('.layer-swatch');
        if (swatch) {
            swatch.addEventListener('click', function(e) {
                e.stopPropagation();
                const info = LayerManager.getLayerInfo(id);
                if (!info || !info.visible) return;
                openStylePanel(id);
            });
        }
        // 单击图层名：高亮并闪烁该图层数据（图层隐藏时不可用，内部校验可见性）
        item.addEventListener('click', function(e) {
            if (e.target.closest('button, input, label, .drag-handle, .layer-swatch')) return;
            if (e.target.closest('.layer-name')) {
                LayerManager.setLayerHighlight(id);
            } else {
                LayerManager.clearLayerHighlight();
            }
        });
        // 双击图层行（按钮除外）：缩放至该图层并高亮闪烁；图层隐藏时不可用
        item.addEventListener('dblclick', function(e) {
            if (e.target.closest('button, input, label, .drag-handle')) return;
            const info = LayerManager.getLayerInfo(id);
            if (!info || !info.visible) return;
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
                LayerManager.zoomToLayer(id);
            });
        }

        // 下载该图层数据（GeoJSON，与可见性无关）
        const downloadBtn = item.querySelector('.download-btn');
        if (downloadBtn) {
            downloadBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                downloadLayer(id);
            });
        }

        const labelBtn = item.querySelector('.label-btn');
        if (labelBtn && !labelBtn.disabled) {
            labelBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                e.preventDefault();
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
        localStorage.setItem('mapTheme', isDark ? 'dark' : 'light');

        const icon = document.querySelector('#toggleTheme i');
        if (icon) {
            icon.className = isDark ? 'fas fa-sun' : 'fas fa-moon';
        }
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

    function togglePanel() {
        const panel = document.getElementById('controlPanel');
        if (!panel) return;
        panel.classList.toggle('collapsed');
        applyPanelButtonState();
    }

    // 同步顶部「图层面板」按钮的图标/文案/高亮，与面板开合状态保持一致
    function applyPanelButtonState() {
        const panel = document.getElementById('controlPanel');
        const panelBtn = document.getElementById('togglePanel');
        if (!panel || !panelBtn) return;
        const hidden = panel.classList.contains('collapsed');
        const icon = panelBtn.querySelector('i');
        if (icon) icon.className = hidden ? 'fas fa-layer-group' : 'fas fa-times';
        panelBtn.classList.toggle('active', !hidden);
        panelBtn.dataset.tooltip = hidden ? '展开图层面板' : '收起图层面板';
        panelBtn.setAttribute('aria-label', hidden ? '展开图层面板' : '收起图层面板');
        panelBtn.setAttribute('aria-expanded', String(!hidden));
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

    function openColorPicker(btn, id) {
        closeColorPicker();
        const key = btn.dataset.colorKey;
        const style = LayerManager.getLayerStyle(id);
        if (!style || !key) return;

        let hsv = hexToHsv(normalizeHex(style[key]));

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
            LayerManager.updateLayerStyle(id, { [key]: hex });
            btn.dataset.color = hex;
            const swatch = btn.querySelector('.color-field-swatch');
            if (swatch) swatch.style.background = hex;
            const hexEl = document.querySelector(`[data-hex-for="${key}"]`);
            if (hexEl) hexEl.textContent = hex.toUpperCase();
            if (document.activeElement !== hexInput) {
                hexInput.value = hex.toUpperCase();
            }
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

        hexInput.value = normalizeHex(style[key]).toUpperCase();
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

    // 透明度字段：滑块以 0~100% 显示，存储为 0~1
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
    // 命名约定：描边类设置（面边界/点边线/线）一律统称「线条」；所有颜色均可配置透明度。
    // 面 → 填充（颜色/透明度）+ 线条（颜色/透明度/宽度）
    // 线 → 线条（颜色/透明度/宽度）；点 → 点（颜色/透明度/大小）+ 线条（颜色/透明度/宽度）
    function buildStyleFields(type, style) {
        const groups = [];
        if (type === 'polygon' || type === 'mixed') {
            groups.push(styleGroup('填充', [
                colorField('fillColor', '颜色', style.fillColor),
                opacityField('fillOpacity', '透明度', style.fillOpacity),
            ]));
            groups.push(styleGroup(type === 'mixed' ? '线条（边界）' : '线条', [
                colorField('strokeColor', '颜色', style.strokeColor),
                opacityField('strokeOpacity', '透明度', style.strokeOpacity),
                rangeField('strokeWidth', '宽度', style.strokeWidth, 0, 8, 0.5, 'px'),
            ]));
        }
        if (type === 'line' || type === 'mixed') {
            groups.push(styleGroup('线条', [
                colorField('lineColor', '颜色', style.lineColor),
                opacityField('lineOpacity', '透明度', style.lineOpacity),
                rangeField('lineWidth', '宽度', style.lineWidth, 0.5, 12, 0.5, 'px'),
            ]));
        }
        if (type === 'point' || type === 'mixed') {
            groups.push(styleGroup('点', [
                colorField('pointColor', '颜色', style.pointColor),
                opacityField('pointOpacity', '透明度', style.pointOpacity),
                rangeField('pointSize', '大小', style.pointSize, 4, 32, 1, 'px'),
            ]));
            groups.push(styleGroup(type === 'mixed' ? '线条（点边线）' : '线条', [
                colorField('pointStrokeColor', '颜色', style.pointStrokeColor),
                opacityField('pointStrokeOpacity', '透明度', style.pointStrokeOpacity),
                rangeField('pointStrokeWidth', '宽度', style.pointStrokeWidth, 0, 6, 0.5, 'px'),
            ]));
        }
        return groups.join('');
    }

    // 同步样式面板内「恢复默认」按钮可用态（样式已偏离默认值才可点击）
    function syncStyleResetState(id) {
        const resetBtn = document.getElementById('styleReset');
        if (resetBtn && id) resetBtn.disabled = LayerManager.isLayerStyleDefault(id);
    }

    // 绑定样式控件输入事件（实时预览）：滑块直接绑定；颜色按钮打开自定义取色器
    function bindStyleInputs(body, id) {
        body.querySelectorAll('input[data-key]').forEach(input => {
            input.addEventListener('input', function() {
                const key = this.dataset.key;
                const value = parseFloat(this.value);
                const valEl = body.querySelector(`[data-val-for="${key}"]`);
                if (valEl) valEl.textContent = `${value}${this.dataset.unit || ''}`;
                // 透明度类滑块（*Opacity）以百分比显示，统一存储为 0~1
                const stored = key.endsWith('Opacity') ? value / 100 : value;
                LayerManager.updateLayerStyle(id, { [key]: stored });
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
        if (sub) sub.textContent = `${geometry.label}图层 · ${info.featureCount} 个要素`;
        const iconEl = modal.querySelector('.style-modal-icon i');
        if (iconEl) iconEl.className = `fas ${geometry.icon}`;
        body.innerHTML = buildStyleFields(getLayerGeometryType(info.data), LayerManager.getLayerStyle(id));
        bindStyleInputs(body, id);
        syncStyleResetState(id);
        modal.hidden = false;
        document.body.classList.add('modal-open');
    }

    function closeStylePanel() {
        closeColorPicker();
        const modal = document.getElementById('styleModal');
        if (modal) modal.hidden = true;
        stylePanelLayerId = null;
        document.body.classList.remove('modal-open');
    }

    function refreshStylePanel() {
        if (!stylePanelLayerId) return;
        closeColorPicker();
        const info = LayerManager.getLayerInfo(stylePanelLayerId);
        const body = document.getElementById('styleModalBody');
        if (!info || !body) return;
        body.innerHTML = buildStyleFields(getLayerGeometryType(info.data), LayerManager.getLayerStyle(stylePanelLayerId));
        bindStyleInputs(body, stylePanelLayerId);
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
        iconEl.className = `fas ${icon}`;
        iconEl.classList.toggle('danger', danger);
        // textContent 避免内容被当作 HTML 解析
        body.textContent = message;
        confirmBtn.textContent = confirmText;
        confirmBtn.classList.toggle('danger', danger);
        cancelBtn.textContent = cancelText || '';
        cancelBtn.hidden = !cancelText;
        // nowrap 时弹窗宽度按内容自适应（一行显示，不折行）
        if (card) card.classList.toggle('nowrap', nowrap);

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
        const detailsEl = overlay.querySelector('#authorModalDetails');
        const contactsEl = overlay.querySelector('#authorModalContacts');
        if (nameEl) nameEl.textContent = author.name || '佚名';
        if (avatarEl) avatarEl.textContent = String(author.name || '?').trim().charAt(0);
        if (taglineEl) taglineEl.textContent = author.tagline || '';
        if (bioEl) bioEl.textContent = author.bio || '';
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
        // 联系方式（邮箱 / GitHub）：邮箱点击复制到剪贴板（mailto 依赖邮件客户端，不可靠）；
        // 外链新窗口打开。文本一律 textContent 防注入
        if (contactsEl) {
            contactsEl.innerHTML = '';
            (author.contacts || []).forEach(contact => {
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
                contactsEl.appendChild(el);
            });
        }

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
        updateLegend,
        updateButtonsState,
        toggleTheme,
        toggleFullscreen,
        togglePanel,
        showToast,
        showAuthorModal,
    };
})();