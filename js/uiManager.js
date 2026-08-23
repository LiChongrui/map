/**
 * UI管理器 - 现代化图层切换
 */

const UIManager = (function() {
    let isDark = false;
    let isFullscreen = false;
    let isPanelCollapsed = false;
    let sortableInstance = null;
    let searchKeyword = '';
    let selectedDataset = '';

    const BUTTON_IDS = [
        'selectAll', 'deselectAll',
        'zoomToAll', 'exportAll', 'refreshAll', 'clearAll'
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
        syncPanelButtonState();
    }

    function getCurrentLayers() {
        return selectedDataset ? LayerManager.getLayersByGroup(selectedDataset) : LayerManager.getAllLayers();
    }

    function getGeometrySummary(data) {
        const types = new Set((data.features || []).map(feature => feature.geometry?.type));
        if (types.has('Point') || types.has('MultiPoint')) return { label: '点', icon: 'fa-circle-dot' };
        if (types.has('LineString') || types.has('MultiLineString')) return { label: '线', icon: 'fa-road' };
        if (types.has('Polygon') || types.has('MultiPolygon')) return { label: '面', icon: 'fa-draw-polygon' };
        return { label: '要素', icon: 'fa-shapes' };
    }

    function updateDatasetOptions() {
        const select = document.getElementById('datasetSelect');
        const count = document.getElementById('datasetLayerCount');
        if (!select) return;
        const groups = [...new Set([...LayerManager.getAllLayers().values()].map(info => info.config.group || '古代洛阳城'))];
        const previousDataset = selectedDataset;
        if (!selectedDataset || !groups.includes(selectedDataset)) selectedDataset = groups[0] || '';
        if (selectedDataset !== previousDataset && selectedDataset) {
            LayerManager.activateGroup(selectedDataset);
        }
        const value = select.querySelector('.dataset-select-value');
        const menu = select.querySelector('.dataset-select-menu');
        if (value) value.textContent = selectedDataset || '暂无数据集';
        if (menu) {
            menu.innerHTML = groups.map(group => `<button type="button" class="dataset-select-option${group === selectedDataset ? ' active' : ''}" role="option" aria-selected="${group === selectedDataset}" data-value="${group}">${group}<i class="fas fa-check"></i></button>`).join('');
            menu.querySelectorAll('.dataset-select-option').forEach(option => option.addEventListener('click', () => {
                selectedDataset = option.dataset.value;
                select.classList.remove('open');
                select.querySelector('.dataset-select-trigger').setAttribute('aria-expanded', 'false');
                LayerManager.activateGroup(selectedDataset);
                updateLayerPanel();
            }));
        }
        if (count) count.textContent = getCurrentLayers().size;
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

        if (sortableInstance) {
            sortableInstance.destroy();
        }

        sortableInstance = Sortable.create(container, {
            handle: '.drag-handle',
            animation: 200,
            easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
            ghostClass: 'dragging',
            dragClass: 'drag-over',
            onEnd: function(evt) {
                const items = container.querySelectorAll('.layer-item');
                const orderedIds = [];
                items.forEach(item => {
                    const id = item.dataset.id;
                    if (id) orderedIds.push(id);
                });
                LayerManager.setLayerOrder(orderedIds);
            }
        });
    }

    function updateButtonsState(enabled) {
        BUTTON_IDS.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.disabled = !enabled;
            }
        });

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
    }

    function updateStats(total, visible, layerCount) {
        // 由 layerManager 调用
    }

    function bindEvents() {
        const datasetSelect = document.getElementById('datasetSelect');
        if (datasetSelect) {
            datasetSelect.querySelector('.dataset-select-trigger').addEventListener('click', function(event) {
                event.stopPropagation();
                const open = datasetSelect.classList.toggle('open');
                this.setAttribute('aria-expanded', String(open));
            });
            document.addEventListener('click', event => {
                if (!datasetSelect.contains(event.target)) {
                    datasetSelect.classList.remove('open');
                    datasetSelect.querySelector('.dataset-select-trigger').setAttribute('aria-expanded', 'false');
                }
            });
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
                LayerManager.filterLayers(searchKeyword);
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
                    MapManager.fitBounds(bounds, { padding: [50, 50] });
                    showToast('已缩放至全部数据', 'success');
                } else {
                    showToast('没有可见的数据图层', 'info');
                }
            });
        }

        const exportBtn = document.getElementById('exportAll');
        if (exportBtn) {
            exportBtn.addEventListener('click', function() {
                const allLayers = getCurrentLayers();
                if (allLayers.size === 0) {
                    showToast('没有数据可导出', 'error');
                    return;
                }
                const data = LayerManager.getAllData();
                if (data.features.length === 0) {
                    showToast('没有数据可导出', 'error');
                    return;
                }
                const jsonStr = JSON.stringify(data, null, 2);
                const blob = new Blob([jsonStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `map_data_${new Date().toISOString().slice(0,10)}.geojson`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                showToast(`✅ 成功导出 ${data.features.length} 个要素`, 'success');
            });
        }

        const refreshBtn = document.getElementById('refreshAll');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function() {
                const allLayers = getCurrentLayers();
                if (allLayers.size === 0) {
                    showToast('暂无图层可刷新', 'info');
                    return;
                }
                showToast('🔄 正在重新加载...', 'info');
                updateButtonsState(false);
                LayerManager.clearAll();
                LayerManager.loadAllLayers().then(result => {
                    if (result.failed > 0) {
                        showToast(`⚠️ 加载失败：${result.failed} 个图层`, 'error');
                    }
                    updateButtonsState(true);
                }).catch(() => {
                    showToast('❌ 重新加载失败', 'error');
                    updateButtonsState(true);
                });
            });
        }

        const clearBtn = document.getElementById('clearAll');
        if (clearBtn) {
            clearBtn.addEventListener('click', function() {
                const allLayers = LayerManager.getAllLayers();
                if (allLayers.size === 0) {
                    showToast('暂无图层可清除', 'info');
                    return;
                }
                if (confirm('确定要清除所有图层吗？')) {
                    LayerManager.clearAll();
                    showToast('已清除所有图层', 'info');
                    updateButtonsState(false);
                }
            });
        }
    }

    // ================================================================
    // updateLayerPanel - 去掉状态文字和删除按钮
    // ================================================================
    function updateLayerPanel() {
        const container = document.getElementById('layerList');
        if (!container) return;

        updateDatasetOptions();
        const allLayers = getCurrentLayers();

        const hasData = allLayers.size > 0;
        updateButtonsState(hasData);

        if (allLayers.size === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-inbox empty-icon"></i>
                    <div class="empty-title">暂无图层数据</div>
                    <div class="empty-desc">
                        请将 GeoJSON 文件放入 <code>data/</code> 目录<br>
                        并在 <code>data/manifest.json</code> 中配置
                    </div>
                </div>
            `;
            return;
        }

        const keyword = searchKeyword.toLowerCase();
        const visibleLayers = [...allLayers].filter(([, info]) =>
            !keyword || info.config.name.toLowerCase().includes(keyword)
        );
        if (visibleLayers.length === 0) {
            container.innerHTML = '<div class="empty-state"><i class="fas fa-search empty-icon"></i><div class="empty-title">没有匹配图层</div><div class="empty-desc">请尝试其他关键词</div></div>';
            return;
        }
        let html = '';
        for (const [id, info] of visibleLayers) {
            const { name, color } = info.config;
            const { visible } = info;
            const { featureCount } = info;
            const isVisible = visible === true;
            const geometry = getGeometrySummary(info.data);
            const labelsEnabled = isVisible && info.hasName;
            
            html += `
                <div class="layer-item ${isVisible ? '' : 'hidden'}" data-id="${id}" data-name="${name}">
                    <i class="fas fa-grip-vertical drag-handle"></i>
                    

                    
                    <div class="layer-color" style="background:${color};"></div>
                    
                    <div class="layer-info">
                        <div class="layer-name">
                            <span>${name}</span>
                        </div>
                        <div class="layer-meta">
                            <span class="meta-type"><i class="fas ${geometry.icon}"></i> ${geometry.label} · 要素数量：${featureCount}</span>
                        </div>
                    </div>

                    <div class="layer-checkbox-wrapper">
                        <input type="checkbox" class="layer-checkbox" id="layer_${id}" ${isVisible ? 'checked' : ''} />
                        <label class="layer-toggle ${isVisible ? 'active' : ''}" for="layer_${id}">
                            <span class="toggle-knob"></span>
                        </label>
                    </div>
                    
                    <div class="layer-actions">
                        <button type="button" class="zoom-btn" data-tooltip="${isVisible ? '缩放至该图层' : '图层隐藏时不可缩放'}" aria-label="缩放至${name}" ${isVisible ? '' : 'disabled'}>
                            <i class="fas fa-crosshairs"></i>
                        </button>
                        <button type="button" class="download-btn" data-tooltip="下载该图层" aria-label="下载${name}">
                            <i class="fas fa-download"></i>
                        </button>
                        <button type="button" class="label-btn ${info.labelsVisible ? 'active' : ''}" data-tooltip="${!isVisible ? '图层隐藏时不可显示标注' : (info.hasName ? (info.labelsVisible ? '隐藏标注' : '显示标注') : '缺少 name 字段，无法标注')}" aria-label="${info.hasName ? (info.labelsVisible ? '隐藏' + name + '标注' : '显示' + name + '标注') : name + '无法标注'}" ${labelsEnabled ? '' : 'disabled'}>
                            <i class="fas fa-tag"></i>
                        </button>
                    </div>
                </div>
            `;
        }

        container.innerHTML = html;

        // ===== 绑定事件 =====
        container.querySelectorAll('.layer-item').forEach(item => {
            const id = item.dataset.id;

            const toggle = item.querySelector('.layer-toggle');
            if (toggle) {
                toggle.addEventListener('click', function(e) {
                    e.stopPropagation();
                    e.preventDefault();
                    const checkbox = document.getElementById(`layer_${id}`);
                    if (checkbox) {
                        checkbox.checked = !checkbox.checked;
                        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                });
            }

            const checkbox = document.getElementById(`layer_${id}`);
            if (checkbox) {
                checkbox.addEventListener('change', function(e) {
                    e.stopPropagation();
                    console.log(`🔄 切换图层: ${id}, 新状态: ${this.checked}`);
                    LayerManager.toggleLayer(id);
                });
            }

            item.addEventListener('click', function(e) {
                if (e.target.closest('.layer-actions') || 
                    e.target.closest('.drag-handle') || 
                    e.target.closest('.layer-toggle') ||
                    e.target.closest('.layer-checkbox')) {
                    return;
                }
                const checkbox = document.getElementById(`layer_${id}`);
                if (checkbox) {
                    checkbox.checked = !checkbox.checked;
                    const event = new Event('change', { bubbles: true });
                    checkbox.dispatchEvent(event);
                }
            });

            const zoomBtn = item.querySelector('.zoom-btn');
            if (zoomBtn) {
                zoomBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    LayerManager.zoomToLayer(id);
                });
            }

            const downloadBtn = item.querySelector('.download-btn');
            if (downloadBtn) {
                downloadBtn.addEventListener('click', function(e) {
                    e.stopPropagation();
                    const info = LayerManager.getLayerInfo(id);
                    if (!info?.data) return;
                    const blob = new Blob([JSON.stringify(info.data, null, 2)], { type: 'application/geo+json' });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `${info.config.name || id}.geojson`;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    URL.revokeObjectURL(url);
                    showToast(`已下载：${info.config.name}`, 'success');
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
        });

        initSortable();
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
        for (const [, info] of allLayers) {
            if (info.visible) {
                const { name, color } = info.config;
                html += `
                    <div class="legend-item">
                        <span class="legend-color" style="background:${color};"></span>
                        ${name}
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
        const panelBtn = document.getElementById('togglePanel');
        if (panel) {
            panel.classList.toggle('collapsed');
            isPanelCollapsed = panel.classList.contains('collapsed');
            const icon = document.querySelector('#togglePanel i');
            if (icon) {
                icon.className = isPanelCollapsed ? 'fas fa-layer-group' : 'fas fa-times';
            }
            syncPanelButtonState();
            const collapseIcon = document.querySelector('#panelCollapse i');
            if (collapseIcon) {
                collapseIcon.className = 'fas fa-times';
            }
            const collapseButton = document.getElementById('panelCollapse');
            if (collapseButton) {
                collapseButton.setAttribute('aria-label', '关闭图层面板');
                collapseButton.dataset.tooltip = '关闭面板';
            }
        }
    }

    function syncPanelButtonState() {
        const panel = document.getElementById('controlPanel');
        const panelBtn = document.getElementById('togglePanel');
        if (!panel || !panelBtn) return;
        const hidden = panel.classList.contains('collapsed');
        panelBtn.dataset.tooltip = hidden ? '打开面板' : '关闭面板';
        panelBtn.setAttribute('aria-label', hidden ? '打开面板' : '关闭面板');
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
        toast.innerHTML = `
            <i class="${icons[type] || icons.info}"></i>
            <span>${message}</span>
        `;

        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    return {
        init,
        updateLayerPanel,
        updateLegend,
        updateButtonsState,
        updateStats,
        toggleTheme,
        toggleFullscreen,
        togglePanel,
        showToast,
    };
})();